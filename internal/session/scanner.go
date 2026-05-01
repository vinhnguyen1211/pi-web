package session

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// SessionInfo describes a resumable Pi session on disk.
type SessionInfo struct {
	ID               string    `json:"id"`
	Path             string    `json:"path"`
	Name             string    `json:"name,omitempty"`
	Cwd              string    `json:"cwd,omitempty"`
	Model            string    `json:"model,omitempty"`
	Entries          int       `json:"entries"`
	ModTime          time.Time `json:"modTime"`
	FirstUserMessage string    `json:"firstUserMessage,omitempty"`
}

// Header is the first line of a Pi session .jsonl file.
type Header struct {
	ID    string `json:"id"`
	Model string `json:"model"`
	Name  string `json:"name,omitempty"`
	Cwd   string `json:"cwd"`
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
	// Lines with embedded images can be very large (base64 data), so increase buffer.
	// Default MaxScanTokenSize is 64KB; images in messages routinely exceed that.
	scanner.Buffer(make([]byte, 1024), 5*1024*1024) // up to 5 MB per line

	// Read first line for header
	if scanner.Scan() {
		if err := json.Unmarshal(scanner.Bytes(), &header); err != nil {
			return SessionInfo{}
		}
	}

	// Count remaining lines as entries; also find the first user message
	entryCount := 0
	var firstUserMessage string
	for scanner.Scan() {
		entryCount++
		if firstUserMessage == "" {
			firstUserMessage = extractFirstUserMessage(scanner.Bytes())
		}
	}

	displayName := header.Name
	if displayName == "" {
		displayName = "Session " + header.ID[:8]
	}

	return SessionInfo{
		ID:               header.ID,
		Path:             path,
		Name:             displayName,
		Cwd:              header.Cwd,
		Model:            header.Model,
		Entries:          entryCount,
		ModTime:          info.ModTime(),
		FirstUserMessage: firstUserMessage,
	}
}

// extractFirstUserMessage tries to parse a JSONL line as a user message and return its text.
func extractFirstUserMessage(line []byte) string {
	var envelope struct {
		Type    string `json:"type"`
		Message struct {
			Role    string      `json:"role"`
			Content interface{} `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(line, &envelope); err != nil {
		return ""
	}
	if envelope.Type != "message" || envelope.Message.Role != "user" {
		return ""
	}

	// Extract text from content array [{ type: "text", text: "..." }]
	switch c := envelope.Message.Content.(type) {
	case []interface{}:
		for _, block := range c {
			if m, ok := block.(map[string]interface{}); ok && m["type"] == "text" {
				text, _ := m["text"].(string)
				if text != "" {
					// Trim and truncate to a readable excerpt
					text = strings.TrimSpace(text)
					// Remove internal newlines for single-line display
					text = strings.ReplaceAll(text, "\n", " ")
					text = strings.ReplaceAll(text, "\r", "")
					if len(text) > 80 {
						return text[:77] + "…"
					}
					return text
				}
			}
		}
	case string:
		text := strings.TrimSpace(c)
		if len(text) > 80 {
			return text[:77] + "…"
		}
		return text
	}
	return ""
}
