package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

type gateway struct {
	ready       atomic.Bool
	connections sync.Map
}

func main() {
	port := envInt("PORT", 8080)
	drainTimeout := time.Duration(envInt("DRAIN_TIMEOUT_MS", 60_000)) * time.Millisecond
	g := &gateway{}
	g.ready.Store(true)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !g.ready.Load() {
			http.Error(w, "draining", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ready"))
	})
	mux.HandleFunc("GET /v1/connect", g.connect)

	server := &http.Server{
		Addr:              fmt.Sprintf(":%d", port),
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		slog.Info("realtime gateway listening", "port", port)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("realtime gateway stopped", "error", err)
			os.Exit(1)
		}
	}()

	shutdownSignal, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-shutdownSignal.Done()
	g.drain(server, drainTimeout)
}

func (g *gateway) connect(w http.ResponseWriter, r *http.Request) {
	if !g.ready.Load() {
		http.Error(w, "draining", http.StatusServiceUnavailable)
		return
	}

	connection, err := websocket.Accept(w, r, nil)
	if err != nil {
		slog.Warn("websocket upgrade failed", "error", err)
		return
	}
	g.connections.Store(connection, struct{}{})
	defer func() {
		g.connections.Delete(connection)
		connection.CloseNow()
	}()

	for {
		messageType, payload, err := connection.Read(context.Background())
		if err != nil {
			return
		}
		slog.Info("gateway received frame", "messageType", messageType, "bytes", len(payload))
	}
}

func (g *gateway) drain(server *http.Server, timeout time.Duration) {
	if !g.ready.CompareAndSwap(true, false) {
		return
	}

	g.connections.Range(func(key, _ any) bool {
		_ = key.(*websocket.Conn).Close(websocket.StatusGoingAway, "gateway draining")
		return true
	})

	shutdownContext, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	_ = server.Shutdown(shutdownContext)
}

func envInt(name string, fallback int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		slog.Warn("invalid integer environment value", "name", name, "value", raw)
		return fallback
	}
	return value
}
