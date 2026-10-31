package api

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"trtree/internal/scan"
	"trtree/internal/sysinfo"
)

// NodeDTO is the JSON representation of one tree node.
type NodeDTO struct {
	ID         int32  `json:"id"`
	Name       string `json:"name"`
	Path       string `json:"path"`
	Type       string `json:"type"`
	Size       int64  `json:"size"`
	Alloc      int64  `json:"alloc"`
	Mtime      int64  `json:"mtime"`
	Count      uint32 `json:"count"`
	ChildCount int    `json:"childCount"`
	Ext        string `json:"ext"`
	Mount      bool   `json:"mount"`
	// ParentID is the parent node id (-1 for the scan root); the UI uses it to
	// resolve "open containing folder" for files and to build parent paths.
	ParentID int32     `json:"parentId"`
	Children []NodeDTO `json:"children,omitempty"`
}

func nodeDTO(t *scan.Tree, id int32) NodeDTO {
	typ := t.TypeOf(id)
	d := NodeDTO{
		ID:         id,
		Name:       t.Name(id),
		Path:       t.Path(id),
		Type:       typ.String(),
		Size:       t.Size[id],
		Alloc:      t.Alloc[id],
		Mtime:      t.Mtime[id],
		Count:      t.DescendantsCount(id),
		ChildCount: t.ChildCountOf(id),
		Mount:      t.IsMount(id),
		ParentID:   t.ParentOf(id),
	}
	if typ == scan.TypeFile {
		d.Ext = scan.ExtOf(d.Name)
	}
	return d
}

func nodesDTO(t *scan.Tree, ids []int32) []NodeDTO {
	out := make([]NodeDTO, 0, len(ids))
	for _, id := range ids {
		out = append(out, nodeDTO(t, id))
	}
	return out
}

// Root is a quick-select location shown in the UI.
type Root struct {
	Label string `json:"label"`
	Path  string `json:"path"`
	Kind  string `json:"kind"`
}

func (s *Server) buildRoots(r *httpRequestInfo) []Root {
	vols := sysinfo.Volumes()
	roots := make([]Root, 0, len(vols)+4)
	seen := make(map[string]bool)
	add := func(label, path, kind string) {
		if path == "" || seen[path] {
			return
		}
		if !strings.HasPrefix(path, "/") {
			return
		}
		seen[path] = true
		roots = append(roots, Root{Label: label, Path: path, Kind: kind})
	}
	for _, v := range vols {
		kind := "volume"
		if v.System {
			kind = "system"
		}
		add(v.Label, v.Path, kind)
	}
	uid := r.uid
	for _, v := range vols {
		if v.System || uid == "" {
			continue
		}
		p := filepath.Join(v.Path, uid)
		if fi, err := os.Stat(p); err == nil && fi.IsDir() {
			label := "我的文件"
			if len(vols) > 2 {
				label = "我的文件 · " + v.Label
			}
			add(label, p, "home")
		}
	}
	for _, p := range splitPaths(os.Getenv("TRIM_DATA_ACCESSIBLE_PATHS")) {
		add(filepath.Base(p), p, "authorized")
	}
	if s.cfg.ShareDir != "" {
		add("应用共享目录", s.cfg.ShareDir, "share")
	}
	if !seen["/"] {
		add("根目录", "/", "root")
	}
	return roots
}

// httpRequestInfo carries gateway identity for helpers.
type httpRequestInfo struct {
	uid  string
	user string
}

func splitPaths(v string) []string {
	if v == "" {
		return nil
	}
	parts := strings.Split(v, ":")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func cmpInt64(a, b int64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	default:
		return 0
	}
}

func sortIDsBySize(t *scan.Tree, ids []int32, desc bool) {
	sort.SliceStable(ids, func(i, j int) bool {
		a, b := ids[i], ids[j]
		if t.Size[a] != t.Size[b] {
			if desc {
				return t.Size[a] > t.Size[b]
			}
			return t.Size[a] < t.Size[b]
		}
		return strings.ToLower(t.Name(a)) < strings.ToLower(t.Name(b))
	})
}

func sanitizeFilename(s string) string {
	if s == "" {
		return "root"
	}
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		case r == ' ' || r == '.':
			b.WriteByte('_')
		default:
			if r < 128 {
				b.WriteByte('_')
			}
		}
	}
	out := b.String()
	if out == "" {
		out = "root"
	}
	if len(out) > 40 {
		out = out[:40]
	}
	return out
}
