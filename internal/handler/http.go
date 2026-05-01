package handler

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"piweb/internal/manager"
	"piweb/internal/session"
	"piweb/internal/workspace"
)

// Router wires up all HTTP routes for the Pi web client.
type Router struct {
	mgr      *manager.Manager
	staticFS embed.FS
}

// New creates a new Router with the given agent manager and embedded static filesystem.
func New(m *manager.Manager, staticFS embed.FS) *Router {
	return &Router{mgr: m, staticFS: staticFS}
}

// ServeMux returns an http.Handler serving all routes.
func (r *Router) ServeMux() http.Handler {
	mux := http.NewServeMux()

	// SSE event stream — per-connection agent
	mux.HandleFunc("GET /stream", r.handleStream)

	// Spawn a new agent for this connection (new session or resume)
	mux.HandleFunc("POST /api/connect", r.handleConnect)

	// Send a command to the Pi agent
	mux.HandleFunc("POST /api/command", r.handleCommand)

	// List reusable sessions
	mux.HandleFunc("GET /api/sessions", r.handleSessions)

	// Workspace management
	mux.HandleFunc("GET /api/workspaces", r.handleWorkspaces)
	mux.HandleFunc("POST /api/workspaces", r.handleAddWorkspace)
	mux.HandleFunc("POST /api/browse", r.handleBrowse)

	// Static files: root serves index.html, everything else maps to embedded static/
	mux.HandleFunc("GET /{path...}", r.handleStatic)

	return mux
}

// handleConnect spawns a new pi agent for the requesting connection.
// Request body: {"type": "new"} or {"type": "resume", "sessionPath": "/path/to/session.jsonl"}
func (r *Router) handleConnect(w http.ResponseWriter, req *http.Request) {
	connID := req.Header.Get("X-Conn-Id")
	if connID == "" {
		http.Error(w, `{"error":"X-Conn-Id header required"}`, http.StatusBadRequest)
		return
	}

	var body struct {
		Type        string `json:"type"`
		SessionPath string `json:"sessionPath,omitempty"`
		Cwd         string `json:"cwd,omitempty"`
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	if body.Type != "new" && body.Type != "resume" {
		http.Error(w, `"type" must be "new" or "resume"`, http.StatusBadRequest)
		return
	}

	// Kill existing agent for this connection if any
	r.mgr.Remove(connID)

	var sessionPath string
	if body.Type == "resume" && body.SessionPath != "" {
		sessionPath = body.SessionPath
	}

	a, err := r.mgr.Spawn(connID, sessionPath, body.Cwd)
	if err != nil {
		log.Printf("handler: connect error: %v", err)
		http.Error(w, fmt.Sprintf("spawn failed: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"ok":     true,
		"connId": connID,
		"pid":    a.PID(),
	})
}

// handleStream pushes agent stdout lines to the client as SSE.
func (r *Router) handleStream(w http.ResponseWriter, req *http.Request) {
	connID := req.URL.Query().Get("connId")
	if connID == "" {
		http.Error(w, `{"error":"connId query param required"}`, http.StatusBadRequest)
		return
	}

	// Ensure cleanup when client disconnects
	defer r.mgr.Remove(connID)

	a := r.mgr.Get(connID)
	if a == nil {
		// No agent for this connection yet — tell client to pick a session
		flusher := w.(http.Flusher)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)

		fmt.Fprint(w, "data: {\"type\":\"awaiting_session\"}\n\n")
		flusher.Flush()

		// Wait for client disconnect or agent to be spawned
		<-req.Context().Done()
		return
	}

	flusher := w.(http.Flusher)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	lines := a.Lines()
	done := req.Context().Done()

	for {
		select {
		case line, ok := <-lines:
			if !ok {
				fmt.Fprintf(w, "event: agent_exited\ndata: {}\n\n")
				flusher.Flush()
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", line)
			flusher.Flush()
		case <-done:
			log.Printf("handler: SSE client disconnected (connId=%s)", connID)
			return
		}
	}
}

// handleCommand accepts a JSON Pi RPC command and writes it to agent stdin.
func (r *Router) handleCommand(w http.ResponseWriter, req *http.Request) {
	connID := req.Header.Get("X-Conn-Id")
	if connID == "" {
		http.Error(w, `"X-Conn-Id" header required`, http.StatusBadRequest)
		return
	}

	a := r.mgr.Get(connID)
	if a == nil {
		http.Error(w, "no agent connected", http.StatusNotFound)
		return
	}

	var cmd map[string]any
	if err := json.NewDecoder(req.Body).Decode(&cmd); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	cmdType, ok := cmd["type"].(string)
	if !ok || cmdType == "" {
		http.Error(w, `"type" field is required`, http.StatusBadRequest)
		return
	}

	if err := a.SendCommand(cmd); err != nil {
		log.Printf("handler: command error (connId=%s): %v", connID, err)
		http.Error(w, fmt.Sprintf("send failed: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, `{"ok":true}`)
}

// handleSessions scans ~/.pi/agent/sessions and returns available sessions.
func (r *Router) handleSessions(w http.ResponseWriter, req *http.Request) {
	sessions, err := session.Scan()
	if err != nil {
		log.Printf("handler: session scan error: %v", err)
		http.Error(w, fmt.Sprintf("scan failed: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sessions)
}

// handleWorkspaces returns the list of saved workspaces.
func (r *Router) handleWorkspaces(w http.ResponseWriter, req *http.Request) {
	ws, err := workspace.Load()
	if err != nil {
		log.Printf("handler: workspace load error: %v", err)
		http.Error(w, fmt.Sprintf("load failed: %v", err), http.StatusInternalServerError)
		return
	}
	if ws == nil {
		ws = []workspace.Workspace{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ws)
}

// handleAddWorkspace adds a workspace path to the store.
func (r *Router) handleAddWorkspace(w http.ResponseWriter, req *http.Request) {
	var body struct {
		Name string `json:"name"`
		Path string `json:"path"`
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if body.Path == "" {
		http.Error(w, `"path" is required`, http.StatusBadRequest)
		return
	}

	// Normalize: trim trailing slashes
	body.Path = strings.TrimRight(body.Path, "/")

	// Validate path exists and is a directory
	info, err := os.Stat(body.Path)
	if err != nil || !info.IsDir() {
		http.Error(w, "path must be an existing directory", http.StatusBadRequest)
		return
	}

	ws, err := workspace.Add(body.Name, body.Path)
	if err != nil {
		log.Printf("handler: workspace add error: %v", err)
		http.Error(w, fmt.Sprintf("add failed: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ws)
}

// handleBrowse opens a native OS folder picker and returns the selected path.
func (r *Router) handleBrowse(w http.ResponseWriter, req *http.Request) {
	var path string

	switch runtime.GOOS {
	case "darwin":
		out, err := exec.Command("osascript", "-e", `POSIX path of (choose folder)`).Output()
		if err != nil {
			http.Error(w, "folder selection cancelled", http.StatusNoContent)
			return
		}
		path = strings.TrimSpace(string(out))
	case "linux":
		out, err := exec.Command("zenity", "--file-selection", "--directory").Output()
		if err != nil {
			http.Error(w, "folder selection cancelled", http.StatusNoContent)
			return
		}
		path = strings.TrimSpace(string(out))
	default:
		http.Error(w, "unsupported OS for folder picker", http.StatusNotImplemented)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"path": path})
}

// handleStatic serves static files from the embedded filesystem.
// Root path / serves index.html directly. No redirects — avoids loops.
func (r *Router) handleStatic(w http.ResponseWriter, req *http.Request) {
	path := strings.TrimPrefix(req.URL.Path, "/")
	if path == "" {
		path = "index.html"
	}

	sub, err := fs.Sub(r.staticFS, "static")
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	info, err := fs.Stat(sub, path)
	if err != nil || info.IsDir() {
		// SPA fallback: serve index.html for unknown paths
		path = "index.html"
		info, err = fs.Stat(sub, path)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
	}

	f, err := sub.Open(path)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	data, err := io.ReadAll(f)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	http.ServeContent(w, req, info.Name(), info.ModTime(), bytes.NewReader(data))
}