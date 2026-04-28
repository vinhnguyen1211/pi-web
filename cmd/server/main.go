package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"piweb/internal/agent"
	"piweb/internal/handler"
)

func main() {
	cwd := flag.String("cwd", "", "Working directory (default: $PWD)")
	sessionID := flag.String("session", "", "Session file or ID to resume")
	addr := flag.String("addr", ":9000", "HTTP listen address")
	noTools := flag.Bool("no-tools", false, "Disable all built-in tools")
	flag.Parse()

	if *cwd == "" {
		*cwd, _ = os.Getwd()
	}

	// Build agent args
	args := []string{"--mode", "rpc"}
	if *sessionID != "" {
		args = append(args, "--session", *sessionID)
	}
	if *noTools {
		args = append(args, "--no-tools")
	}

	a, err := agent.New(*cwd, args...)
	if err != nil {
		log.Fatalf("Failed to start Pi agent: %v", err)
	}

	log.Printf("Pi agent started (PID %d)", a.PID())

	r := handler.New(a, staticFS)

	srv := &http.Server{
		Addr:    *addr,
		Handler: r.ServeMux(),
	}

	// Graceful shutdown: when SIGINT/SIGTERM received, kill the agent
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("Serving on %s", *addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTP error: %v", err)
		}
	}()

	// Wait for shutdown signal
	<-ctx.Done()
	log.Println("Shutting down...")

	stop() // stop listening for more signals

	if err := a.Kill(); err != nil {
		log.Printf("Error killing agent: %v", err)
	}

	log.Println("Bye!")
}
