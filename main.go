package main

import (
	"context"
	"embed"
	"errors"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"time"

	"trtree/internal/api"
	"trtree/internal/version"
)

//go:embed all:src/web
var embeddedWeb embed.FS

func main() {
	log.SetFlags(log.LstdFlags)
	log.SetPrefix("[trtree] ")

	debug.SetGCPercent(60)
	applyMemoryLimit()

	webFS, err := fs.Sub(embeddedWeb, "src/web")
	if err != nil {
		log.Fatalf("embed web: %v", err)
	}

	dataDir := firstEnv("TRTREE_DATA_DIR", "TRIM_PKGVAR")
	if dataDir == "" {
		dataDir = "./data"
	}
	shareDir := os.Getenv("TRTREE_SHARE_DIR")
	if shareDir == "" {
		shareDir = firstDataShare(os.Getenv("TRIM_DATA_SHARE_PATHS"))
	}
	gatewayPrefix := os.Getenv("TRTREE_GATEWAY_PREFIX")
	if gatewayPrefix == "" {
		gatewayPrefix = "/app/trtree"
	}
	maxNodes := 4_000_000
	if v := os.Getenv("TRTREE_MAX_NODES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 10000 {
			maxNodes = n
		}
	}

	srv := api.New(api.Config{
		Version:        version.Version,
		DataDir:        dataDir,
		ShareDir:       shareDir,
		GatewayPrefix:  gatewayPrefix,
		WebFS:          webFS,
		WebDir:         os.Getenv("TRTREE_WEB_DIR"),
		MaxScanNodes:   maxNodes,
		AllowAll:       os.Getenv("TRTREE_ALLOW_ALL") == "1",
		RequireGateway: os.Getenv("TRTREE_SOCKET") != "",
		StartedAt:      time.Now(),
	})

	httpSrv := &http.Server{
		Handler:           srv,
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	socket := os.Getenv("TRTREE_SOCKET")
	var ln net.Listener
	if socket != "" {
		if err := os.MkdirAll(filepath.Dir(socket), 0o755); err != nil {
			log.Printf("mkdir socket dir: %v", err)
		}
		if fi, err := os.Lstat(socket); err == nil {
			if fi.Mode()&os.ModeSocket != 0 {
				_ = os.Remove(socket)
			}
		}
		ln, err = net.Listen("unix", socket)
		if err != nil {
			log.Fatalf("listen unix %s: %v", socket, err)
		}
		_ = os.Chmod(socket, 0o755)
		log.Printf("listening on unix:%s prefix=%s data=%s", socket, gatewayPrefix, dataDir)
	} else {
		host := os.Getenv("HOST")
		if host == "" {
			host = "127.0.0.1"
		}
		port := os.Getenv("PORT")
		if port == "" {
			port = "18080"
		}
		addr := net.JoinHostPort(host, port)
		ln, err = net.Listen("tcp", addr)
		if err != nil {
			log.Fatalf("listen tcp %s: %v", addr, err)
		}
		log.Printf("listening on http://%s/ data=%s", addr, dataDir)
	}

	go func() {
		if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("serve: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	log.Printf("shutting down...")

	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(ctx); err != nil {
		log.Printf("shutdown: %v", err)
	}
	if socket != "" {
		_ = os.Remove(socket)
	}
}

func firstEnv(keys ...string) string {
	for _, k := range keys {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v
		}
	}
	return ""
}

func firstDataShare(v string) string {
	if v == "" {
		return ""
	}
	for _, p := range strings.Split(v, ":") {
		p = strings.TrimSpace(p)
		if p != "" {
			return p
		}
	}
	return ""
}

// applyMemoryLimit keeps the Go heap within a safe fraction of physical RAM so
// very large scans do not trigger the kernel OOM killer on small NAS devices.
func applyMemoryLimit() {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return
	}
	var totalKB int64
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				totalKB, _ = strconv.ParseInt(fields[1], 10, 64)
			}
			break
		}
	}
	if totalKB <= 0 {
		return
	}
	limit := totalKB * 1024 * 65 / 100
	if limit < 512*1024*1024 {
		limit = 512 * 1024 * 1024
	}
	debug.SetMemoryLimit(limit)
	log.Printf("memory limit set to %d MiB (system %d MiB)", limit/1024/1024, totalKB/1024)
}
