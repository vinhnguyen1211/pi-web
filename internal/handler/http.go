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
	"path/filepath"
	"strings"

	"piweb/internal/manager"
	"piweb/internal/session"
)

// Router wires up all HTTP routes for the Pi web client.
type Router struct {
	mgr      *manager.Manager
	staticFS embed.FS
	allowed  bool // whether to allow opening arbitrary folders (default: true)
}

// New creates a new Router with the given agent manager and embedded static filesystem.
// Folder opening is enabled by default.
func New(m *manager.Manager, staticFS embed.FS) *Router {
	return &Router{mgr: m, staticFS: staticFS, allowed: true}
}

// NewRestricted creates a Router that does NOT allow opening arbitrary folders.
// Only new sessions and session resumption are supported.
func NewRestricted(m *manager.Manager, staticFS embed.FS) *Router {
	return &Router{mgr: m, staticFS: staticFS, allowed: false}
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

	// List sessions with alive background agents
	mux.HandleFunc("GET /api/active-agents", r.handleActiveAgents)

	// Open a project folder (v2 feature)
	mux.HandleFunc("POST /api/open-folder", r.handleOpenFolder)

	// Static files: root serves index.html, everything else maps to embedded static/
	mux.HandleFunc("GET /{path...}", r.handleStatic)

	return mux
}

// handleConnect spawns a new pi agent for the requesting connection.
// Request body: {"type": "new"} or {"type": "resume", "sessionPath": "/path/to/session.jsonl"}
// Optional: {"folderPath": "/path/to/project"} to set working directory.
func (r *Router) handleConnect(w http.ResponseWriter, req *http.Request) {
	connID := req.Header.Get("X-Conn-Id")
	if connID == "" {
		http.Error(w, `{"error":"X-Conn-Id header required"}`, http.StatusBadRequest)
		return
	}

	var body struct {
		Type        string `json:"type"`
		SessionPath string `json:"sessionPath,omitempty"`
		FolderPath  string `json:"folderPath,omitempty"`
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

	a, err := r.mgr.Spawn(connID, sessionPath, body.FolderPath)
	if err != nil {
		log.Printf("handler: connect error: %v", err)
		http.Error(w, fmt.Sprintf("spawn failed: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"ok":        true,
		"connId":    connID,
		"pid":       a.PID(),
		"folderPath": body.FolderPath,
	})
}

// handleStream pushes agent stdout lines to the client as SSE.
func (r *Router) handleStream(w http.ResponseWriter, req *http.Request) {
	connID := req.URL.Query().Get("connId")
	if connID == "" {
		http.Error(w, `{"error":"connId query param required"}`, http.StatusBadRequest)
		return
	}

	// Deregister keeps agent alive in background (killed after 5 min inactivity)
	defer func() {
		log.Printf("handler: SSE disconnected, deregistering connId=%s", connID)
		r.mgr.Deregister(connID)
	}()

	a := r.mgr.Get(connID)
	log.Printf("handler: SSE stream opened for connId=%s, agent exists=%v", connID, a != nil)
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

	// Reset inactivity timer on each command
	r.mgr.Touch(connID)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, `{"ok":true}`)
}

// handleOpenFolder accepts a folder path and opens it for the given connection.
// Request body: {"folderPath": "/path/to/project", "connId": "..."}
func (r *Router) handleOpenFolder(w http.ResponseWriter, req *http.Request) {
	var body struct {
		FolderPath string `json:"folderPath"`
		ConnID     string `json:"connId,omitempty"`
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	if body.FolderPath == "" {
		http.Error(w, `{"error":"folderPath is required"}`, http.StatusBadRequest)
		return
	}

	if !r.allowed {
		http.Error(w, `{"error":"opening arbitrary folders is disabled"}`, http.StatusForbidden)
		return
	}

	if err := r.mgr.OpenFolder(body.ConnID, body.FolderPath); err != nil {
		log.Printf("handler: open-folder error: %v", err)
		http.Error(w, fmt.Sprintf("failed to open folder: %v", err), http.StatusBadRequest)
		return
	}

	abs, _ := filepath.Abs(body.FolderPath)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"ok":       true,
		"folder":   abs,
		"connId":   body.ConnID,
	})
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

// handleActiveAgents returns session paths that have alive background agents.
func (r *Router) handleActiveAgents(w http.ResponseWriter, req *http.Request) {
	active := r.mgr.ActiveSessions()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"active": active,
	})
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
		http.Error(w, "not found", http.StatusNotFound)
		return
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
