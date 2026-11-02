package api

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path"
	"runtime"
	"strings"
	"time"
)

// Config is the runtime configuration for the HTTP server.
type Config struct {
	Version        string
	DataDir        string
	ShareDir       string
	GatewayPrefix  string
	WebFS          fs.FS
	WebDir         string
	MaxScanNodes   int
	AllowAll       bool
	RequireGateway bool
	StartedAt      time.Time
}

// Server implements http.Handler.
type Server struct {
	cfg  Config
	mux  *http.ServeMux
	jobs *Manager
}

// New creates a server and its routes.
func New(cfg Config) *Server {
	if cfg.GatewayPrefix == "" {
		cfg.GatewayPrefix = "/app/trtree"
	}
	if cfg.MaxScanNodes <= 0 {
		cfg.MaxScanNodes = 4_000_000
	}
	if cfg.StartedAt.IsZero() {
		cfg.StartedAt = time.Now()
	}
	s := &Server{
		cfg:  cfg,
		mux:  http.NewServeMux(),
		jobs: NewManager(cfg.DataDir, cfg.MaxScanNodes),
	}
	s.routes()
	return s
}

func (s *Server) routes() {
	m := s.mux
	m.HandleFunc("GET /api/health", s.handleHealth)
	m.HandleFunc("GET /api/context", s.handleContext)
	m.HandleFunc("GET /api/volumes", s.handleVolumes)
	m.HandleFunc("GET /api/browse", s.handleBrowse)
	m.HandleFunc("GET /api/scans", s.handleListScans)
	m.HandleFunc("DELETE /api/history", s.handleDeleteHistory)
	m.HandleFunc("POST /api/scans", s.handleStartScan)
	m.HandleFunc("GET /api/scans/{id}", s.handleGetScan)
	m.HandleFunc("DELETE /api/scans/{id}", s.handleDeleteScan)
	m.HandleFunc("POST /api/scans/{id}/cancel", s.handleCancelScan)
	m.HandleFunc("GET /api/scans/{id}/progress", s.handleProgress)
	m.HandleFunc("GET /api/scans/{id}/tree", s.handleTree)
	m.HandleFunc("GET /api/scans/{id}/treemap", s.handleTreemap)
	m.HandleFunc("GET /api/scans/{id}/children", s.handleChildren)
	m.HandleFunc("GET /api/scans/{id}/search", s.handleSearch)
	m.HandleFunc("GET /api/scans/{id}/top", s.handleTop)
	m.HandleFunc("GET /api/scans/{id}/extensions", s.handleExtensions)
	m.HandleFunc("GET /api/scans/{id}/errors", s.handleErrors)
	m.HandleFunc("GET /api/scans/{id}/locate", s.handleLocate)
	m.HandleFunc("GET /api/scans/{id}/open", s.handleOpen)
	m.HandleFunc("DELETE /api/scans/{id}/nodes", s.handleDelete)
	m.HandleFunc("GET /api/scans/{id}/export", s.handleExportCSV)
	m.HandleFunc("GET /api/scans/{id}/export.json", s.handleExportJSON)
	m.HandleFunc("/", s.handleStatic)
}

// ServeHTTP strips the fnOS gateway prefix and enforces the admin gate.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	p := r.URL.Path
	prefix := s.cfg.GatewayPrefix
	if prefix != "" && prefix != "/" {
		if p == prefix {
			http.Redirect(w, r, prefix+"/", http.StatusFound)
			return
		}
		if strings.HasPrefix(p, prefix+"/") {
			p = strings.TrimPrefix(p, prefix)
		} else if strings.HasPrefix(p, "/api/") || p == "/api" {
			// API also reachable at root for local development
		} else if !strings.HasPrefix(p, "/") {
			http.NotFound(w, r)
			return
		}
	}

	if strings.HasPrefix(p, "/api/") && p != "/api/health" {
		if !s.isAdmin(r) {
			writeErr(w, http.StatusForbidden, "需要管理员权限")
			return
		}
	}

	r2 := r.Clone(r.Context())
	u := *r.URL
	u.Path = p
	r2.URL = &u
	s.mux.ServeHTTP(w, r2)
}

func (s *Server) isAdmin(r *http.Request) bool {
	if s.cfg.AllowAll {
		return true
	}
	if v := r.Header.Get("X-Trim-Isadmin"); v != "" {
		return strings.EqualFold(v, "true")
	}
	if s.cfg.RequireGateway {
		// In production the fnOS gateway always injects the identity headers;
		// local socket clients must not bypass the admin check.
		return false
	}
	// Local development / direct port access: only loopback.
	if r.Header.Get("X-Trim-Userid") == "" && isLocal(r.RemoteAddr) {
		return true
	}
	return false
}

func isLocal(remote string) bool {
	if remote == "" || strings.HasPrefix(remote, "unix") || strings.HasPrefix(remote, "@") {
		return true
	}
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	if host == "127.0.0.1" || host == "::1" || host == "localhost" {
		return true
	}
	return false
}

func (s *Server) userName(r *http.Request) string {
	if v := r.Header.Get("X-Trim-Username"); v != "" {
		return v
	}
	return ""
}

func (s *Server) userID(r *http.Request) string {
	return r.Header.Get("X-Trim-Userid")
}

// ---------- helpers ----------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		log.Printf("write json: %v", err)
	}
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func readJSON(r *http.Request, dst any) error {
	defer r.Body.Close()
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return err
	}
	if len(body) == 0 {
		return errors.New("空请求体")
	}
	return json.Unmarshal(body, dst)
}

func parseBoolDefault(v string, def bool) bool {
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return def
	}
}

// ---------- misc handlers ----------

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"app":     "trtree",
		"version": s.cfg.Version,
		"time":    time.Now().UnixMilli(),
	})
}

func (s *Server) handleContext(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"app":           "trtree",
		"version":       s.cfg.Version,
		"isAdmin":       s.isAdmin(r),
		"user":          s.userName(r),
		"sysVersion":    envOr("TRIM_SYS_VERSION", ""),
		"arch":          runtime.GOARCH,
		"dataDir":       s.cfg.DataDir,
		"shareDir":      s.cfg.ShareDir,
		"gatewayPrefix": s.cfg.GatewayPrefix,
		"maxScanNodes":  s.cfg.MaxScanNodes,
	})
}

func envOr(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	p := path.Clean(r.URL.Path)
	if p == "/api" || strings.HasPrefix(p, "/api/") {
		http.NotFound(w, r)
		return
	}
	if p == "/" || p == "." {
		p = "/index.html"
	}
	if strings.Contains(p, "..") {
		http.NotFound(w, r)
		return
	}
	rootFS := s.cfg.WebFS
	if s.cfg.WebDir != "" {
		rootFS = os.DirFS(s.cfg.WebDir)
	}
	if rootFS == nil {
		http.Error(w, "web assets not embedded", http.StatusInternalServerError)
		return
	}
	name := strings.TrimPrefix(p, "/")
	f, err := rootFS.Open(name)
	if err != nil {
		// SPA fallback for extension-less paths
		if path.Ext(name) == "" {
			f, err = rootFS.Open("index.html")
			if err == nil {
				serveWebFile(w, r, "index.html", f)
				return
			}
		}
		http.NotFound(w, r)
		return
	}
	serveWebFile(w, r, name, f)
}

func serveWebFile(w http.ResponseWriter, r *http.Request, name string, f fs.File) {
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	switch strings.ToLower(path.Ext(name)) {
	case ".html":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
	case ".js":
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	case ".css":
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
	case ".svg":
		w.Header().Set("Content-Type", "image/svg+xml")
	case ".png":
		w.Header().Set("Content-Type", "image/png")
	case ".ico":
		w.Header().Set("Content-Type", "image/x-icon")
	case ".json":
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
	case ".webmanifest":
		w.Header().Set("Content-Type", "application/manifest+json")
	default:
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	w.Header().Set("Cache-Control", "no-cache")
	rs, ok := f.(io.ReadSeeker)
	if ok {
		http.ServeContent(w, r, name, st.ModTime(), rs)
		return
	}
	data, err := io.ReadAll(f)
	if err != nil {
		http.Error(w, "read error", http.StatusInternalServerError)
		return
	}
	w.Write(data)
}
