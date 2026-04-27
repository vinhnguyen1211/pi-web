package session

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// SessionInfo describes a resumable Pi session on disk.
type SessionInfo struct {
	ID      string    `json:"id"`
	Path    string    `json:"path"`
	Name    string    `json:"name,omitempty"`
	Model   string    `json:"model,omitempty"`
	Entries int       `json:"entries"`
	ModTime time.Time `json:"modTime"`
}

// Header is the first line of a Pi session .jsonl file.
type Header struct {
	ID    string `json:"id"`
	Model string `json:"model"`
	Name  string `json:"name,omitempty"`
}

// Scan lists all resuable sessions under ~/.pi/agent/sessions/.
func Scan() ([]SessionInfo, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("session: home dir: %w", err)
	}

	base := filepath.Join(home, ".pi", "agent", "sessions")

	var sessions []SessionInfo

	err = filepath.Walk(base, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip inaccessible dirs
		}
		if !info.IsDir() && filepath.Ext(path) == ".jsonl" {
			info := readSession(path)
			if info.ID != "" {
				sessions = append(sessions, info)
			}
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("session: walk: %w", err)
	}

	// Sort by modification time, newest first
	sort.Slice(sessions, func(i, j int) bool {
		return sessions[i].ModTime.After(sessions[j].ModTime)
	})

	return sessions, nil
}

func readSession(path string) SessionInfo {
	f, err := os.Open(path)
	if err != nil {
		return SessionInfo{}
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return SessionInfo{}
	}

	var header Header
	scanner := bufio.NewScanner(f)

	// Read first line for header
	if scanner.Scan() {
		if err := json.Unmarshal(scanner.Bytes(), &header); err != nil {
			return SessionInfo{}
		}
	}

	// Count remaining lines as entries
	entryCount := 0
	for scanner.Scan() {
		entryCount++
	}

	displayName := header.Name
	if displayName == "" {
		displayName = "Session " + header.ID[:8]
	}

	return SessionInfo{
		ID:      header.ID,
		Path:    path,
		Name:    displayName,
		Model:   header.Model,
		Entries: entryCount,
		ModTime: info.ModTime(),
	}
}
