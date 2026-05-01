package manager

import (
	"log"
	"sync"

	"piweb/internal/agent"
)

// Manager tracks per-connection Pi agent instances.
type Manager struct {
	mu       sync.RWMutex
	agents   map[string]*agent.Agent // connId -> Agent
	cwd      string
	provider string
	model    string
}

// New creates a new Manager with the given working directory, provider, and model.
func New(cwd, provider, model string) *Manager {
	return &Manager{
		agents:   make(map[string]*agent.Agent),
		cwd:      cwd,
		provider: provider,
		model:    model,
	}
}

// Spawn creates a new pi agent subprocess for the given connection.
// If sessionPath is non-empty, it passes --session to pi.
// If cwd is non-empty, it overrides the manager's default cwd.
func (m *Manager) Spawn(connID, sessionPath, cwd string) (*agent.Agent, error) {
	args := []string{"--mode", "rpc"}
	if m.provider != "" {
		args = append(args, "--provider", m.provider)
	}
	if m.model != "" {
		args = append(args, "--model", m.model)
	}
	if sessionPath != "" {
		args = append(args, "--session", sessionPath)
	}

	useCwd := m.cwd
	if cwd != "" {
		useCwd = cwd
	}

	a, err := agent.New(useCwd, args...)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	m.agents[connID] = a
	m.mu.Unlock()

	log.Printf("manager: spawned agent %s (PID %d) session=%q", connID, a.PID(), sessionPath)
	return a, nil
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