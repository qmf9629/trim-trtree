package api

import (
	"bytes"
	"compress/gzip"
	"container/heap"
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"trtree/internal/scan"
)

// TreemapNode is a compact nested node for the WizTree-style treemap.
// It omits path (the UI rebuilds it from parent path + name) to keep large
// responses small. Children is present only when the directory was expanded.
type TreemapNode struct {
	ID         int32         `json:"id"`
	Name       string        `json:"name"`
	Type       string        `json:"type"`
	Size       int64         `json:"size"`
	Alloc      int64         `json:"alloc"`
	Mtime      int64         `json:"mtime"`
	Count      uint32        `json:"count"`
	ChildCount int           `json:"childCount"`
	Ext        string        `json:"ext,omitempty"`
	Mount      bool          `json:"mount,omitempty"`
	ParentID   int32         `json:"parentId"`
	Children   []TreemapNode `json:"children,omitempty"`
	// Hidden is the number of direct children left out because they were too
	// small to be visible (their size is still part of Size).
	Hidden int `json:"hidden,omitempty"`
}

const (
	treemapDefaultBudget = 16000
	treemapMaxBudget     = 60000
	treemapDefaultArea   = 1_500_000
	treemapMaxDepth      = 48
	treemapMaxKidsPerDir = 4000
	// 子项至少要能画出约 3px²，目录至少约 120px² 才值得继续展开
	treemapMinChildPx  = 3.0
	treemapMinExpandPx = 120.0
)

type tmBuild struct {
	id     int32
	depth  int
	kids   []*tmBuild
	hidden int
	open   bool
}

// buildTreemap expands the subtree below root, largest directories first,
// until budget nodes have been emitted. Children smaller than minChild bytes
// are skipped (counted in Hidden); directories smaller than minExpand bytes
// are not opened. The result is deterministic for a given tree.
func buildTreemap(t *scan.Tree, root int32, budget int, minChild, minExpand int64) (*tmBuild, int, bool) {
	rb := &tmBuild{id: root}
	h := &tmPQ{}
	heap.Push(h, tmItem{b: rb, size: t.Size[root]})
	used := 0
	exhausted := false
	for h.Len() > 0 {
		it := heap.Pop(h).(tmItem)
		b := it.b
		kids := t.Children(b.id)
		if len(kids) == 0 {
			b.open = true
			continue
		}
		sort.Slice(kids, func(i, j int) bool {
			si, sj := t.Size[kids[i]], t.Size[kids[j]]
			if si != sj {
				return si > sj
			}
			return kids[i] < kids[j]
		})
		remaining := budget - used
		if remaining <= 0 {
			exhausted = true
			break
		}
		b.open = true
		limit := len(kids)
		if limit > treemapMaxKidsPerDir {
			limit = treemapMaxKidsPerDir
		}
		if limit > remaining {
			limit = remaining
			exhausted = true
		}
		b.kids = make([]*tmBuild, 0, limit)
		for i, kid := range kids {
			sz := t.Size[kid]
			if i >= limit || sz < minChild || sz <= 0 {
				b.hidden = len(kids) - i
				break
			}
			cb := &tmBuild{id: kid, depth: b.depth + 1}
			b.kids = append(b.kids, cb)
			used++
			if t.TypeOf(kid) == scan.TypeDir && !t.IsMount(kid) && sz >= minExpand &&
				t.ChildCountOf(kid) > 0 && cb.depth < treemapMaxDepth {
				heap.Push(h, tmItem{b: cb, size: sz})
			}
		}
	}
	return rb, used, exhausted
}

type tmItem struct {
	b    *tmBuild
	size int64
}

type tmPQ []tmItem

func (h tmPQ) Len() int { return len(h) }
func (h tmPQ) Less(i, j int) bool {
	if h[i].size != h[j].size {
		return h[i].size > h[j].size
	}
	return h[i].b.id < h[j].b.id
}
func (h tmPQ) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *tmPQ) Push(x any)   { *h = append(*h, x.(tmItem)) }
func (h *tmPQ) Pop() any {
	old := *h
	n := len(old)
	it := old[n-1]
	*h = old[:n-1]
	return it
}

func treemapDTO(t *scan.Tree, b *tmBuild) TreemapNode {
	id := b.id
	typ := t.TypeOf(id)
	d := TreemapNode{
		ID:         id,
		Name:       t.Name(id),
		Type:       typ.String(),
		Size:       t.Size[id],
		Alloc:      t.Alloc[id],
		Mtime:      t.Mtime[id],
		Count:      t.DescendantsCount(id),
		ChildCount: t.ChildCountOf(id),
		Mount:      t.IsMount(id),
		ParentID:   t.ParentOf(id),
		Hidden:     b.hidden,
	}
	if typ == scan.TypeFile {
		d.Ext = scan.ExtOf(d.Name)
	}
	if b.open && len(b.kids) > 0 {
		d.Children = make([]TreemapNode, 0, len(b.kids))
		for _, k := range b.kids {
			d.Children = append(d.Children, treemapDTO(t, k))
		}
	}
	return d
}

// handleTreemap serves GET /api/scans/{id}/treemap.
//
// Query: node (default 0), budget (max nodes, default 16000, max 60000),
// area (canvas area in CSS px², used to derive the visibility thresholds).
func (s *Server) handleTreemap(w http.ResponseWriter, r *http.Request) {
	j, ok := s.readyJob(w, r)
	if !ok {
		return
	}
	t := j.Tree()
	node := queryNode(r)
	if node < 0 || int(node) >= t.Len() {
		writeErr(w, http.StatusNotFound, "节点不存在")
		return
	}
	budget := queryInt(r, "budget", treemapDefaultBudget)
	if budget < 1 {
		budget = treemapDefaultBudget
	}
	if budget > treemapMaxBudget {
		budget = treemapMaxBudget
	}
	area := float64(treemapDefaultArea)
	if v := r.URL.Query().Get("area"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f >= 10_000 && f <= 40_000_000 {
			area = f
		}
	}
	rootSize := float64(t.Size[node])
	minChild := int64(rootSize * treemapMinChildPx / area)
	minExpand := int64(rootSize * treemapMinExpandPx / area)
	if minChild < 1 {
		minChild = 1
	}

	b, used, exhausted := buildTreemap(t, node, budget, minChild, minExpand)
	root := treemapDTO(t, b)
	nd := nodeDTO(t, node)
	writeJSONGzip(w, r, http.StatusOK, map[string]any{
		"node":      nd,
		"children":  nonNilTM(root.Children),
		"hidden":    root.Hidden,
		"nodes":     used,
		"budgetHit": exhausted,
		"minSize":   minChild,
	})
}

func nonNilTM(v []TreemapNode) []TreemapNode {
	if v == nil {
		return []TreemapNode{}
	}
	return v
}

// writeJSONGzip is writeJSON with gzip for large bodies when the client accepts it.
// The nested treemap is typically 1–3 MB of JSON and compresses ~7x.
func writeJSONGzip(w http.ResponseWriter, r *http.Request, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		writeErr(w, http.StatusInternalServerError, "编码失败")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Add("Vary", "Accept-Encoding")
	if buf.Len() < 16<<10 || !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.WriteHeader(status)
		_, _ = w.Write(buf.Bytes())
		return
	}
	h.Set("Content-Encoding", "gzip")
	w.WriteHeader(status)
	gz, _ := gzip.NewWriterLevel(w, gzip.BestSpeed)
	if _, err := gz.Write(buf.Bytes()); err != nil {
		log.Printf("write gzip json: %v", err)
	}
	_ = gz.Close()
}
