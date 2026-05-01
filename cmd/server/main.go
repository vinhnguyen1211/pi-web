package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"piweb/internal/handler"
	"piweb/internal/manager"
)

func main() {
	cwd := flag.String("cwd", "", "Working directory (default: $PWD)")
	addr := flag.String("addr", ":9000", "HTTP listen address")
	provider := flag.String("provider", "", "Provider name passed to pi (default: pi settings)")
	model := flag.String("model", "", "Model ID or pattern passed to pi (default: pi settings)")
	flag.Parse()

	if *cwd == "" {
		*cwd, _ = os.Getwd()
	}

	mgr := manager.New(*cwd, *provider, *model)

	r := handler.New(mgr, staticFS)

	srv := &http.Server{
		Addr:    *addr,
		Handler: r.ServeMux(),
	}

	// Graceful shutdown: when SIGINT/SIGTERM received, kill all agents
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

	mgr.Cleanup()

	log.Println("Bye!")
}