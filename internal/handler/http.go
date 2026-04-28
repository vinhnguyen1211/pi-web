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
	"strings"
	"sync/atomic"

	"piweb/internal/agent"
	"piweb/internal/session"
)

// Router wires up all HTTP routes for the Pi web client.
type Router struct {
	agent    *agent.Agent
	staticFS embed.FS
}

// New creates a new Router with the given agent and embedded static filesystem.
func New(a *agent.Agent, staticFS embed.FS) *Router {
	return &Router{agent: a, staticFS: staticFS}
}

// ServeMux returns an http.Handler serving all routes.
func (r *Router) ServeMux() http.Handler {
	mux := http.NewServeMux()

	// SSE event stream — single client only
	mux.HandleFunc("GET /stream", r.handleStream)

	// Send a command to the Pi agent
	mux.HandleFunc("POST /api/command", r.handleCommand)

	// List reusable sessions
	mux.HandleFunc("GET /api/sessions", r.handleSessions)

	// Static files: root serves index.html, everything else maps to embedded static/
	mux.HandleFunc("GET /{path...}", r.handleStatic)

	return mux
}

// handleStream pushes agent stdout lines to the client as SSE.
var activeClients int32 // atomic counter for single-client enforcement

func (r *Router) handleStream(w http.ResponseWriter, req *http.Request) {
	cur := atomic.AddInt32(&activeClients, 1)
	if cur > 1 {
		log.Println("handler: second SSE client rejected")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		fmt.Fprint(w, `{"error":"another client is already connected"}`)
		atomic.AddInt32(&activeClients, -1)
		return
	}

	defer atomic.AddInt32(&activeClients, -1)

	flusher := w.(http.Flusher)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	lines := r.agent.Lines()
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
			log.Println("handler: SSE client disconnected")
			return
		}
	}
}

// handleCommand accepts a JSON Pi RPC command and writes it to agent stdin.
func (r *Router) handleCommand(w http.ResponseWriter, req *http.Request) {
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

	if err := r.agent.SendCommand(cmd); err != nil {
		log.Printf("handler: command error: %v", err)
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