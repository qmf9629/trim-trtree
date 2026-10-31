package scan

import (
	"container/heap"
	"sort"
	"strings"
	"sync"
)

// NodeType identifies the kind of a filesystem entry.
type NodeType uint8

const (
	TypeFile NodeType = iota
	TypeDir
	TypeLink
	TypeOther
)

func (t NodeType) String() string {
	switch t {
	case TypeDir:
		return "dir"
	case TypeLink:
		return "link"
	case TypeFile:
		return "file"
	default:
		return "other"
	}
}

// Candidate is one directory entry collected by a scan worker.
type Candidate struct {
	Name  string
	Type  NodeType
	Size  int64
	Alloc int64
	Mtime int64
	Mount bool
}

// ExtStat aggregates file sizes by extension.
type ExtStat struct {
	Ext   string `json:"ext"`
	Size  int64  `json:"size"`
	Alloc int64  `json:"alloc"`
	Count int64  `json:"count"`
}

// Tree is a compact, append-only filesystem tree stored in parallel slices.
// Node 0 is the scan root. Child indexes are always greater than their parent,
// which lets Aggregate() run as a single reverse pass.
type Tree struct {
	Names       []string
	Parent      []int32
	Size        []int64
	Alloc       []int64
	Mtime       []int64
	Type        []uint8
	FirstChild  []int32
	LastChild   []int32
	NextSibling []int32
	ChildCount  []uint32
	Total       []uint32 // recursive entry count, includes self
	Mount       []bool

	RootPath  string
	RootDev   uint64
	Truncated bool
	MaxNodes  int

	TotalFiles int64
	TotalDirs  int64
	Links      int64

	ExtStats []ExtStat
	TopFiles []int32

	mu sync.Mutex
}

// NewTree creates a tree with a single root directory node.
func NewTree(rootPath, rootName string, rootDev uint64, maxNodes int) *Tree {
	t := &Tree{
		RootPath: rootPath,
		RootDev:  rootDev,
		MaxNodes: maxNodes,
	}
	t.Names = append(t.Names, rootName)
	t.Parent = append(t.Parent, -1)
	t.Size = append(t.Size, 0)
	t.Alloc = append(t.Alloc, 0)
	t.Mtime = append(t.Mtime, 0)
	t.Type = append(t.Type, uint8(TypeDir))
	t.FirstChild = append(t.FirstChild, -1)
	t.LastChild = append(t.LastChild, -1)
	t.NextSibling = append(t.NextSibling, -1)
	t.ChildCount = append(t.ChildCount, 0)
	t.Total = append(t.Total, 1)
	t.Mount = append(t.Mount, false)
	t.TotalDirs = 1
	return t
}

// AddChildren appends a batch of entries under parent and returns their ids.
// Sibling order is the order in which workers happened to add them; callers sort.
func (t *Tree) AddChildren(parent int32, batch []Candidate) []int32 {
	if len(batch) == 0 || parent < 0 || int(parent) >= len(t.Names) {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()

	ids := make([]int32, 0, len(batch))
	for _, c := range batch {
		idx := int32(len(t.Names))
		t.Names = append(t.Names, c.Name)
		t.Parent = append(t.Parent, parent)
		t.Size = append(t.Size, c.Size)
		t.Alloc = append(t.Alloc, c.Alloc)
		t.Mtime = append(t.Mtime, c.Mtime)
		t.Type = append(t.Type, uint8(c.Type))
		t.FirstChild = append(t.FirstChild, -1)
		t.LastChild = append(t.LastChild, -1)
		t.NextSibling = append(t.NextSibling, -1)
		t.ChildCount = append(t.ChildCount, 0)
		t.Total = append(t.Total, 1)
		t.Mount = append(t.Mount, c.Mount)

		last := t.LastChild[parent]
		if last == -1 {
			t.FirstChild[parent] = idx
		} else {
			t.NextSibling[last] = idx
		}
		t.LastChild[parent] = idx
		t.ChildCount[parent]++

		if c.Type == TypeDir {
			t.TotalDirs++
		} else {
			t.TotalFiles++
			if c.Type == TypeLink {
				t.Links++
			}
		}
		ids = append(ids, idx)
	}
	return ids
}

// Len returns the number of nodes.
func (t *Tree) Len() int { return len(t.Names) }

// Aggregate folds child sizes into parents in one reverse pass.
func (t *Tree) Aggregate() {
	for i := len(t.Names) - 1; i > 0; i-- {
		p := t.Parent[i]
		if p < 0 {
			continue
		}
		t.Size[p] += t.Size[i]
		t.Alloc[p] += t.Alloc[i]
		t.Total[p] += t.Total[i]
	}
}

// Children returns direct children ids in insertion order.
func (t *Tree) Children(id int32) []int32 {
	if id < 0 || int(id) >= len(t.Names) {
		return nil
	}
	n := int(t.ChildCount[id])
	if n == 0 {
		return nil
	}
	out := make([]int32, 0, n)
	for c := t.FirstChild[id]; c != -1; c = t.NextSibling[c] {
		out = append(out, c)
	}
	return out
}

// ChildCountOf returns the number of direct children.
func (t *Tree) ChildCountOf(id int32) int {
	if id < 0 || int(id) >= len(t.Names) {
		return 0
	}
	return int(t.ChildCount[id])
}

// ParentOf returns the parent id, or -1 when id is the root (or out of range).
func (t *Tree) ParentOf(id int32) int32 {
	if id <= 0 || int(id) >= len(t.Names) {
		return -1
	}
	return t.Parent[id]
}

// Name returns the node name.
func (t *Tree) Name(id int32) string {
	if id < 0 || int(id) >= len(t.Names) {
		return ""
	}
	return t.Names[id]
}

// TypeOf returns the node type.
func (t *Tree) TypeOf(id int32) NodeType {
	if id < 0 || int(id) >= len(t.Names) {
		return TypeOther
	}
	return NodeType(t.Type[id])
}

// IsMount reports whether the node is a filesystem boundary.
func (t *Tree) IsMount(id int32) bool {
	if id < 0 || int(id) >= len(t.Names) {
		return false
	}
	return t.Mount[id]
}

// Path rebuilds the absolute path of a node.
func (t *Tree) Path(id int32) string {
	if id < 0 || int(id) >= len(t.Names) {
		return ""
	}
	if id == 0 {
		return t.RootPath
	}
	parts := make([]string, 0, 8)
	for cur := id; cur > 0; cur = t.Parent[cur] {
		parts = append(parts, t.Names[cur])
	}
	var b strings.Builder
	b.Grow(len(t.RootPath) + 64)
	b.WriteString(t.RootPath)
	endsSlash := strings.HasSuffix(t.RootPath, "/")
	for i := len(parts) - 1; i >= 0; i-- {
		if !endsSlash {
			b.WriteByte('/')
		}
		b.WriteString(parts[i])
		endsSlash = false
	}
	return b.String()
}

// Ancestors returns ids from root to the parent of id (excludes id).
func (t *Tree) Ancestors(id int32) []int32 {
	if id <= 0 || int(id) >= len(t.Names) {
		return nil
	}
	rev := make([]int32, 0, 8)
	for cur := t.Parent[id]; cur > 0; cur = t.Parent[cur] {
		rev = append(rev, cur)
	}
	out := make([]int32, 0, len(rev)+1)
	out = append(out, 0)
	for i := len(rev) - 1; i >= 0; i-- {
		out = append(out, rev[i])
	}
	return out
}

// DescendantsCount returns recursive entry count of a directory, excluding itself.
func (t *Tree) DescendantsCount(id int32) uint32 {
	if id < 0 || int(id) >= len(t.Names) {
		return 0
	}
	c := t.Total[id]
	if t.Type[id] == uint8(TypeDir) && c > 0 {
		return c - 1
	}
	return c
}

// ExtOf returns a normalized lowercase extension (without dot) for file names.
func ExtOf(name string) string {
	i := strings.LastIndexByte(name, '.')
	if i <= 0 || i == len(name)-1 {
		return ""
	}
	ext := name[i+1:]
	if len(ext) > 16 {
		return ""
	}
	hasUpper := false
	for j := 0; j < len(ext); j++ {
		if ext[j] >= 'A' && ext[j] <= 'Z' {
			hasUpper = true
			break
		}
	}
	if hasUpper {
		b := []byte(ext)
		for j := range b {
			if b[j] >= 'A' && b[j] <= 'Z' {
				b[j] += 'a' - 'A'
			}
		}
		ext = string(b)
	}
	return ext
}

// Finalize computes extension statistics and the largest-file list.
func (t *Tree) Finalize(topN int) {
	extMap := make(map[string]*ExtStat, 128)
	files := make([]int32, 0, 1024)
	for i := 1; i < len(t.Names); i++ {
		typ := NodeType(t.Type[i])
		if typ != TypeFile {
			continue
		}
		files = append(files, int32(i))
		ext := ExtOf(t.Names[i])
		st := extMap[ext]
		if st == nil {
			st = &ExtStat{Ext: ext}
			extMap[ext] = st
		}
		st.Size += t.Size[i]
		st.Alloc += t.Alloc[i]
		st.Count++
	}
	stats := make([]ExtStat, 0, len(extMap))
	for _, st := range extMap {
		stats = append(stats, *st)
	}
	sort.Slice(stats, func(i, j int) bool {
		if stats[i].Size != stats[j].Size {
			return stats[i].Size > stats[j].Size
		}
		return stats[i].Ext < stats[j].Ext
	})
	t.ExtStats = stats

	if topN <= 0 {
		topN = 1000
	}
	t.TopFiles = topLargest(t, files, topN)
}

type fileHeap struct {
	ids []int32
	t   *Tree
}

func (h fileHeap) Len() int { return len(h.ids) }
func (h fileHeap) Less(i, j int) bool {
	return h.t.Size[h.ids[i]] < h.t.Size[h.ids[j]]
}
func (h fileHeap) Swap(i, j int) { h.ids[i], h.ids[j] = h.ids[j], h.ids[i] }
func (h *fileHeap) Push(x any)   { h.ids = append(h.ids, x.(int32)) }
func (h *fileHeap) Pop() any {
	old := h.ids
	n := len(old)
	x := old[n-1]
	h.ids = old[:n-1]
	return x
}

func topLargest(t *Tree, files []int32, k int) []int32 {
	if k <= 0 || len(files) == 0 {
		return nil
	}
	if len(files) <= k {
		out := append([]int32(nil), files...)
		sort.Slice(out, func(i, j int) bool { return t.Size[out[i]] > t.Size[out[j]] })
		return out
	}
	h := &fileHeap{t: t}
	heap.Init(h)
	for _, id := range files {
		if h.Len() < k {
			heap.Push(h, id)
		} else if t.Size[id] > t.Size[h.ids[0]] {
			h.ids[0] = id
			heap.Fix(h, 0)
		}
	}
	out := make([]int32, len(h.ids))
	copy(out, h.ids)
	sort.Slice(out, func(i, j int) bool { return t.Size[out[i]] > t.Size[out[j]] })
	return out
}
