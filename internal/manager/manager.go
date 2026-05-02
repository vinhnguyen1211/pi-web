package manager

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"piweb/internal/agent"
)

// inactivityTimeout is how long to keep a background agent alive after
// the last client disconnects. After this period with no active connection
// or command, the agent is killed.
const inactivityTimeout = 5 * time.Minute

// Manager tracks per-connection Pi agent instances.
type Manager struct {
	mu         sync.RWMutex
	agents     map[string]*agent.Agent       // connId -> Agent (actively connected)
	inactive   map[string]*agent.Agent       // connId -> Agent (disconnected but alive, keyed by original connId)
	cwd        string                        // fallback default CWD (process dir)
	sessionCwd map[string]string             // sessionPath -> working directory for that session
	connFolder map[string]string             // connId -> folderPath (current open folder)
}

// New creates a new Manager with the given fallback working directory.
// Agents opened without an explicit folder will use this as their CWD.
func New(cwd string) *Manager {
	m := &Manager{
		agents:     make(map[string]*agent.Agent),
		inactive:   make(map[string]*agent.Agent),
		cwd:        cwd,
		sessionCwd: make(map[string]string),
		connFolder: make(map[string]string),
	}
	m.StartSweep(60 * time.Second)
	return m
}

// Spawn creates a new pi agent subprocess for the given connection.
// Parameters:
//   - connID: unique connection identifier
//   - sessionPath: optional path to an existing session .jsonl file
//   - folderPath: optional explicit working directory (overrides session CWD and fallback)
//   - provider: optional model provider name (passed as --provider flag)
//   - model: optional model pattern or ID (passed as --model flag)
func (m *Manager) Spawn(connID, sessionPath, folderPath, provider, model string) (*agent.Agent, error) {
	cwd := m.resolveCWD(sessionPath, folderPath)

	args := []string{"--mode", "rpc"}
	if sessionPath != "" {
		args = append(args, "--session", sessionPath)
	}
	if provider != "" {
		args = append(args, "--provider", provider)
	}
	if model != "" {
		args = append(args, "--model", model)
	}

	a, err := agent.New(cwd, args...)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()

	// If an inactive agent exists for this connId (same tab reconnected), kill it
	if old, ok := m.inactive[connID]; ok {
		delete(m.inactive, connID)
		log.Printf("manager: spawn — replacing inactive agent from same connId (PID %d → %d)", old.PID(), a.PID())
		_ = old.Kill()
	}

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

// Deregister moves the agent from active to inactive when a client disconnects.
// The agent stays alive in the background and is killed after inactivityTimeout.
func (m *Manager) Deregister(connID string) {
	m.mu.Lock()
	a, ok := m.agents[connID]
	if ok {
		delete(m.agents, connID)
		delete(m.connFolder, connID)
	}
	m.mu.Unlock()

	if !ok || a == nil {
		return
	}

	sp := a.SessionPath()
	folder := m.getFolder(connID)

	// Move to inactive — keyed by connId so Spawn can replace the same tab's agent
	m.mu.Lock()
	if old, exists := m.inactive[connID]; exists {
		delete(m.inactive, connID)
		m.mu.Unlock()
		log.Printf("manager: deregister — replacing existing inactive agent for connId (PID %d → %d)", old.PID(), a.PID())
		_ = old.Kill()
	}
	m.inactive[connID] = a
	m.mu.Unlock()

	if sp != "" {
		log.Printf("manager: deregister connId=%s → inactive (session=%q, PID=%d)", connID, sp, a.PID())
	} else {
		log.Printf("manager: deregister connId=%s → inactive (new session, folder=%q, PID=%d)", connID, folder, a.PID())
	}
}

// Remove kills and removes the agent for the given connection ID immediately.
// Use Deregister for normal SSE disconnect; use Remove only for explicit kill.
func (m *Manager) Remove(connID string) {
	m.mu.Lock()
	a, ok := m.agents[connID]
	if ok {
		delete(m.agents, connID)
		delete(m.connFolder, connID)
	}
	m.mu.Unlock()

	if ok && a != nil {
		log.Printf("manager: removing agent %s", connID)
		if err := a.Kill(); err != nil {
			log.Printf("manager: error killing agent %s: %v", connID, err)
		}
	}
}

// Touch updates the last-activity timestamp for the agent connected to connID.
func (m *Manager) Touch(connID string) {
	m.mu.RLock()
	a := m.agents[connID]
	m.mu.RUnlock()
	if a != nil {
		a.Touch()
	}
}

// ActiveSessions returns the set of session paths that have an alive background agent.
func (m *Manager) ActiveSessions() map[string]bool {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make(map[string]bool)

	// Active agents with session paths
	for _, a := range m.agents {
		if sp := a.SessionPath(); sp != "" {
			result[sp] = true
		}
	}

	// Inactive agents (all have connId as key, but show session path or folder)
	for _, a := range m.inactive {
		if a.IsAlive() {
			if sp := a.SessionPath(); sp != "" {
				result[sp] = true
			}
		}
	}

	return result
}

// Sweep kills inactive agents that have been idle longer than inactivityTimeout
// or are no longer alive.
func (m *Manager) Sweep() {
	m.mu.Lock()
	var toKill []*agent.Agent
	for connID, a := range m.inactive {
		if !a.IsAlive() || a.TimeSinceActivity() > inactivityTimeout {
			toKill = append(toKill, a)
			log.Printf("manager: sweep — killing inactive agent connId=%s (PID=%d, idle=%v)",
				connID, a.PID(), a.TimeSinceActivity())
			delete(m.inactive, connID)
		}
	}
	m.mu.Unlock()

	for _, a := range toKill {
		_ = a.Kill()
	}
}

// StartSweep runs a background goroutine that periodically sweeps inactive agents.
func (m *Manager) StartSweep(interval time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			m.Sweep()
		}
	}()
}

// getFolder is a helper to safely read connFolder under the lock.
func (m *Manager) getFolder(connID string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.connFolder[connID]
}

// Cleanup kills all tracked agents (active and inactive).
func (m *Manager) Cleanup() {
	m.mu.Lock()
	allAgents := make([]*agent.Agent, 0, len(m.agents)+len(m.inactive))
	for _, a := range m.agents {
		allAgents = append(allAgents, a)
	}
	for _, a := range m.inactive {
		allAgents = append(allAgents, a)
	}
	m.agents = make(map[string]*agent.Agent)
	m.inactive = make(map[string]*agent.Agent)
	m.mu.Unlock()

	for _, a := range allAgents {
		if err := a.Kill(); err != nil {
			log.Printf("manager: error killing agent (PID %d): %v", a.PID(), err)
		}
	}
}
