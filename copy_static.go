//go:build ignore

// copy_static copies static/ into cmd/server/static/ so go:embed can include them.
// Usage: go run copy_static.go
package main

import (
	"fmt"
	"os"
	"path/filepath"
)

func main() {
	src := "static"
	dst := "cmd/server/static"

	// Remove old copy
	if err := os.RemoveAll(dst); err != nil && !os.IsNotExist(err) {
		fmt.Fprintf(os.Stderr, "remove: %v\n", err)
		os.Exit(1)
	}

	// Copy dir
	if err := copyDir(src, dst); err != nil {
		fmt.Fprintf(os.Stderr, "copy: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("Copied static/ → cmd/server/static/")
}

func copyDir(src, dst string) error {
	srcInfo, err := os.Stat(src)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(dst, srcInfo.Mode()); err != nil {
		return err
	}

	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())

		if entry.IsDir() {
			if err := copyDir(srcPath, dstPath); err != nil {
				return err
			}
		} else {
			if err := copyFile(srcPath, dstPath); err != nil {
				return err
			}
		}
	}

	return nil
}

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0644)
}