package manager

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"

	"piweb/internal/agent"
)

// Manager tracks per-connection Pi agent instances.
type Manager struct {
	mu         sync.RWMutex
	agents     map[string]*agent.Agent // connId -> Agent
	cwd        string                  // fallback default CWD (process dir)
	sessionCwd map[string]string       // sessionPath -> working directory for that session
	connFolder map[string]string       // connId -> folderPath (current open folder)
}

// New creates a new Manager with the given fallback working directory.
// Agents opened without an explicit folder will use this as their CWD.
func New(cwd string) *Manager {
	return &Manager{
		agents:     make(map[string]*agent.Agent),
		cwd:        cwd,
		sessionCwd: make(map[string]string),
		connFolder: make(map[string]string),
	}
}

// Spawn creates a new pi agent subprocess for the given connection.
// Parameters:
//   - connID: unique connection identifier
//   - sessionPath: optional path to an existing session .jsonl file
//   - folderPath: optional explicit working directory (overrides session CWD and fallback)
func (m *Manager) Spawn(connID, sessionPath, folderPath string) (*agent.Agent, error) {
	cwd := m.resolveCWD(sessionPath, folderPath)

	args := []string{"--mode", "rpc"}
	if sessionPath != "" {
		args = append(args, "--session", sessionPath)
	}

	a, err := agent.New(cwd, args...)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	m.agents[connID] = a
	if folderPath != "" {
		m.connFolder[connID] = folderPath
	}
	m.mu.Unlock()

	log.Printf("manager: spawned agent %s (PID %d) session=%q folder=%q", connID, a.PID(), sessionPath, cwd)
	return a, nil
}

// resolveCWD determines the working directory for a new agent.
// Priority: explicit folderPath > session header CWD > fallback cwd.
func (m *Manager) resolveCWD(sessionPath, folderPath string) string {
	// 1. Explicit folder path wins
	if folderPath != "" {
		abs, err := filepath.Abs(folderPath)
		if err == nil {
			m.sessionCwd[sessionPath] = abs
			return abs
		}
	}

	// 2. Session header CWD (read from .jsonl file)
	if sessionPath != "" {
		if cwd, ok := m.sessionCwd[sessionPath]; ok {
			return cwd
		}
		cwd := readSessionCWD(sessionPath)
		if cwd != "" {
			m.sessionCwd[sessionPath] = cwd
			return cwd
		}
	}

	// 3. Fallback to default
	return m.cwd
}

// readSessionCWD reads the CWD from a session .jsonl file header.
func readSessionCWD(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	var header struct {
		ID  string `json:"id"`
		Cwd string `json:"cwd"`
	}
	scanner := bufio.NewScanner(f)
	if scanner.Scan() {
		if err := json.Unmarshal(scanner.Bytes(), &header); err != nil {
			return ""
		}
	}
	return header.Cwd
}

// OpenFolder sets the working directory for an existing connection.
// The next command sent will execute in this folder.
// (For v1, we mainly use Spawn — but this enables live switching later.)
func (m *Manager) OpenFolder(connID, folderPath string) error {
	abs, err := filepath.Abs(folderPath)
	if err != nil {
		return fmt.Errorf("invalid path %q: %w", folderPath, err)
	}

	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("%q is not a valid directory", folderPath)
	}

	m.mu.Lock()
	m.connFolder[connID] = abs
	m.mu.Unlock()

	log.Printf("manager: opened folder %q for conn %s", abs, connID)
	return nil
}

// GetFolder returns the current open folder for a connection.
func (m *Manager) GetFolder(connID string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.connFolder[connID]
}

// Get returns the agent for the given connection ID, or nil.
func (m *Manager) Get(connID string) *agent.Agent {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.agents[connID]
}

// Remove kills and removes the agent for the given connection ID.
func (m *Manager) Remove(connID string) {
	m.mu.Lock()
	a, ok := m.agents[connID]
	if ok {
		delete(m.agents, connID)
	}
	m.mu.Unlock()

	if ok && a != nil {
		log.Printf("manager: removing agent %s", connID)
		if err := a.Kill(); err != nil {
			log.Printf("manager: error killing agent %s: %v", connID, err)
		}
	}
}

// Cleanup kills all tracked agents.
func (m *Manager) Cleanup() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, a := range m.agents {
		log.Printf("manager: cleanup agent %s", id)
		if err := a.Kill(); err != nil {
			log.Printf("manager: error killing agent %s: %v", id, err)
		}
	}
	m.agents = make(map[string]*agent.Agent)
}