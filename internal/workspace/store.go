package workspace

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

type Workspace struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	IsCurrent bool   `json:"is_current"`
}

var (
	mu   sync.Mutex
	home string
)

func dir() (string, error) {
	if home == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("workspace: home dir: %w", err)
		}
		home = h
	}
	return filepath.Join(home, ".pi", "pi-web"), nil
}

func filePath() (string, error) {
	d, err := dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "workspaces.json"), nil
}

func Load() ([]Workspace, error) {
	mu.Lock()
	defer mu.Unlock()

	fp, err := filePath()
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(fp)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("workspace: read: %w", err)
	}

	if len(data) == 0 {
		return nil, nil
	}

	var result struct {
		Workspaces []Workspace `json:"workspaces"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("workspace: parse: %w", err)
	}
	return result.Workspaces, nil
}

func Save(workspaces []Workspace) error {
	mu.Lock()
	defer mu.Unlock()

	d, err := dir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(d, 0755); err != nil {
		return fmt.Errorf("workspace: mkdir: %w", err)
	}

	data, err := json.MarshalIndent(struct {
		Workspaces []Workspace `json:"workspaces"`
	}{Workspaces: workspaces}, "", "  ")
	if err != nil {
		return fmt.Errorf("workspace: marshal: %w", err)
	}

	fp := filepath.Join(d, "workspaces.json")
	tmp := fp + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return fmt.Errorf("workspace: write tmp: %w", err)
	}
	if err := os.Rename(tmp, fp); err != nil {
		return fmt.Errorf("workspace: rename: %w", err)
	}
	return nil
}

func Add(name, path string) ([]Workspace, error) {
	ws, err := Load()
	if err != nil {
		return nil, err
	}

	if name == "" {
		name = filepath.Base(path)
	}

	for i := range ws {
		ws[i].IsCurrent = ws[i].Path == path
	}

	found := false
	for i, w := range ws {
		if w.Path == path {
			ws[i].Name = name
			found = true
			break
		}
	}
	if !found {
		ws = append(ws, Workspace{Name: name, Path: path, IsCurrent: true})
	}

	if err := Save(ws); err != nil {
		return nil, err
	}
	return ws, nil
}

func SetCurrent(path string) ([]Workspace, error) {
	ws, err := Load()
	if err != nil {
		return nil, err
	}

	for i := range ws {
		ws[i].IsCurrent = ws[i].Path == path
	}

	if err := Save(ws); err != nil {
		return nil, err
	}
	return ws, nil
}
