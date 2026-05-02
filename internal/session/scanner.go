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
	Provider         string    `json:"provider,omitempty"`
	Model            string    `json:"model,omitempty"`
	Entries          int       `json:"entries"`
	ModTime          time.Time `json:"modTime"`
	FirstUserMessage string    `json:"firstUserMessage,omitempty"`
}

// Header is the first line of a Pi session .jsonl file.
type Header struct {
	ID    string `json:"id"`
	Model string `json:"model,omitempty"`
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

	var provider string
	var modelId string
	var entryCount int
	var firstUserMessage string

	// Read first line for session header (metadata like id, name, cwd)
	if scanner.Scan() {
		if err := json.Unmarshal(scanner.Bytes(), &header); err != nil {
			return SessionInfo{}
		}
	}

	// Process remaining lines — extract model_change (last wins), count entries, find first user message
	for scanner.Scan() {
		entryCount++

		// Check if this is a model_change entry — keep overwriting so the last one wins
		var mc struct {
			Type     string `json:"type"`
			Provider string `json:"provider"`
			ModelId  string `json:"modelId"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &mc); err == nil && mc.Type == "model_change" {
			if mc.Provider != "" {
				provider = mc.Provider
			}
			if mc.ModelId != "" {
				modelId = mc.ModelId
			}
		}

		// Capture the first user message (skip non-message lines like model_change)
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
		Provider:         provider,
		Model:            modelId,
		Entries:          entryCount,
		ModTime:          info.ModTime(),
		FirstUserMessage: firstUserMessage,
	}
}

// extractFirstUserMessage tries to parse a JSONL line as a user message
// and return its first text block.
//
// Content is decoded as []json.RawMessage so that image blocks (which contain
// a huge base64 "data" field) are never fully decoded into Go strings — the
// raw bytes stay in the original line buffer, saving memory.
func extractFirstUserMessage(line []byte) string {
	var envelope struct {
		Type    string `json:"type"`
		Message struct {
			Role    string            `json:"role"`
			Content []json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(line, &envelope); err != nil {
		return ""
	}
	if envelope.Type != "message" || envelope.Message.Role != "user" {
		return ""
	}

	for _, raw := range envelope.Message.Content {
		// Peek at the type field cheaply.
		var typed struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(raw, &typed); err != nil || typed.Type != "text" {
			continue // skip image blocks — never decode the "data" field
		}

		var textBlock struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal(raw, &textBlock); err != nil {
			continue
		}

		text := strings.TrimSpace(textBlock.Text)
		text = strings.ReplaceAll(text, "\n", " ")
		text = strings.ReplaceAll(text, "\r", "")
		if text == "" {
			continue
		}

		if len(text) > 80 {
			return text[:77] + "…"
		}
		return text
	}
	return ""
}
