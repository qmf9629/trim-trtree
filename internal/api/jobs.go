package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"trtree/internal/scan"
)

const (
	StatusRunning   = "running"
	StatusDone      = "done"
	StatusCancelled = "cancelled"
	StatusError     = "error"
)

// Summary is the public metadata of a scan.
type Summary struct {
	ID         string  `json:"id"`
	Path       string  `json:"path"`
	Status     string  `json:"status"`
	StartedAt  int64   `json:"startedAt"`
	FinishedAt int64   `json:"finishedAt"`
	DurationMs int64   `json:"durationMs"`
	Files      int64   `json:"files"`
	Dirs       int64   `json:"dirs"`
	Size       int64   `json:"size"`
	Alloc      int64   `json:"alloc"`
	Errors     int64   `json:"errors"`
	Error      *string `json:"error"`
	Truncated  bool    `json:"truncated"`
}

// Job is one scan (running or finished).
type Job struct {
	ID    string
	Root  string
	oneFS bool

	mu         sync.RWMutex
	status     string
	startedAt  time.Time
	finishedAt time.Time
	errMsg     string
	tree       *scan.Tree
	prog       *scan.Progress
	errs       []scan.ScanError
	cancel     context.CancelFunc
	truncated  bool

	cacheMu sync.Mutex
	cache   map[string][]int32
}

func (j *Job) cacheKey(node int32, sortKey, dir string) string {
	return fmt.Sprintf("%d|%s|%s", node, sortKey, dir)
}

func (j *Job) sortedChildren(node int32, sortKey, dir string) []int32 {
	key := j.cacheKey(node, sortKey, dir)
	j.cacheMu.Lock()
	if v, ok := j.cache[key]; ok {
		j.cacheMu.Unlock()
		return v
	}
	j.cacheMu.Unlock()

	kids := j.tree.Children(node)
	if len(kids) == 0 {
		return nil
	}
	t := j.tree
	desc := dir != "asc"
	sort.SliceStable(kids, func(a, b int) bool {
		ia, ib := kids[a], kids[b]
		var cmp int
		switch sortKey {
		case "name":
			cmp = strings.Compare(strings.ToLower(t.Name(ia)), strings.ToLower(t.Name(ib)))
		case "mtime":
			cmp = cmpInt64(t.Mtime[ia], t.Mtime[ib])
		case "alloc":
			cmp = cmpInt64(t.Alloc[ia], t.Alloc[ib])
		case "count":
			cmp = cmpInt64(int64(t.Total[ia]), int64(t.Total[ib]))
		default: // size
			cmp = cmpInt64(t.Size[ia], t.Size[ib])
		}
		if cmp == 0 {
			cmp = strings.Compare(strings.ToLower(t.Name(ia)), strings.ToLower(t.Name(ib)))
			if cmp == 0 {
				return ia < ib
			}
		}
		if desc {
			return cmp > 0
		}
		return cmp < 0
	})
	j.cacheMu.Lock()
	j.cache[key] = kids
	j.cacheMu.Unlock()
	return kids
}

// Manager owns all scan jobs and their history.
type Manager struct {
	mu       sync.RWMutex
	scans    map[string]*Job
	order    []string
	active   string
	history  []Summary
	dataDir  string
	maxNodes int
}

// NewManager creates a manager and loads persisted history.
func NewManager(dataDir string, maxNodes int) *Manager {
	m := &Manager{
		scans:    make(map[string]*Job),
		dataDir:  dataDir,
		maxNodes: maxNodes,
	}
	m.loadHistory()
	return m
}

func (m *Manager) Start(root string, oneFS bool) (*Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active != "" {
		if j := m.scans[m.active]; j != nil {
			if j.Status() == StatusRunning {
				return nil, fmt.Errorf("已有扫描任务正在运行")
			}
		}
		m.active = ""
	}
	ctx, cancel := context.WithCancel(context.Background())
	j := &Job{
		ID:        newID(),
		Root:      root,
		oneFS:     oneFS,
		status:    StatusRunning,
		prog:      scan.NewProgress(),
		cancel:    cancel,
		cache:     make(map[string][]int32),
		startedAt: time.Now(),
	}
	m.scans[j.ID] = j
	m.order = append(m.order, j.ID)
	m.active = j.ID
	go m.run(ctx, j)
	return j, nil
}

func (m *Manager) run(ctx context.Context, j *Job) {
	opts := scan.DefaultOptions()
	opts.OneFilesystem = j.oneFS
	opts.MaxNodes = m.maxNodes
	tree, errs, err := scan.Scan(ctx, j.Root, opts, j.prog)

	now := time.Now()
	j.mu.Lock()
	j.finishedAt = now
	j.errs = errs
	switch {
	case err != nil:
		j.status = StatusError
		j.errMsg = err.Error()
	case ctx.Err() != nil:
		j.status = StatusCancelled
	default:
		j.status = StatusDone
	}
	if tree != nil {
		j.tree = tree
		j.truncated = tree.IsTruncated()
	}
	j.mu.Unlock()

	m.mu.Lock()
	if m.active == j.ID {
		m.active = ""
	}
	m.history = append([]Summary{j.Summary()}, m.history...)
	if len(m.history) > 20 {
		m.history = m.history[:20]
	}
	m.pruneLocked()
	m.mu.Unlock()
	m.saveHistory()
}

// pruneLocked keeps at most 5 job results in memory.
func (m *Manager) pruneLocked() {
	for len(m.scans) > 5 {
		removed := false
		for _, id := range m.order {
			if id == m.active {
				continue
			}
			j := m.scans[id]
			if j == nil {
				continue
			}
			if j.Status() != StatusRunning {
				delete(m.scans, id)
				m.order = removeString(m.order, id)
				removed = true
				break
			}
		}
		if !removed {
			break
		}
	}
}

func removeString(s []string, v string) []string {
	out := s[:0]
	for _, x := range s {
		if x != v {
			out = append(out, x)
		}
	}
	return out
}

func (m *Manager) Get(id string) *Job {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.scans[id]
}

func (m *Manager) List() ([]Summary, string) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Summary, 0, len(m.scans))
	for _, id := range m.order {
		if j := m.scans[id]; j != nil {
			out = append(out, j.Summary())
		}
	}
	return out, m.active
}

func (m *Manager) Cancel(id string) error {
	m.mu.RLock()
	j := m.scans[id]
	m.mu.RUnlock()
	if j == nil {
		return fmt.Errorf("扫描任务不存在")
	}
	j.mu.RLock()
	st := j.status
	j.mu.RUnlock()
	if st != StatusRunning {
		return fmt.Errorf("扫描任务已结束")
	}
	j.cancel()
	return nil
}

func (m *Manager) Delete(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active == id {
		return fmt.Errorf("扫描正在进行，无法删除")
	}
	if _, ok := m.scans[id]; !ok {
		return fmt.Errorf("扫描任务不存在")
	}
	delete(m.scans, id)
	m.order = removeString(m.order, id)
	return nil
}

// ErrHistoryNotFound 表示没有被匹配到的历史记录。
var ErrHistoryNotFound = errors.New("历史记录不存在")

// DeleteHistory 删除指定路径的全部历史记录，返回删除的条数。
// 只清理持久化的历史列表，不动内存中仍可查看的扫描结果。
func (m *Manager) DeleteHistory(path string) (int, error) {
	target := normalizeHistoryPath(path)
	if target == "" {
		return 0, fmt.Errorf("缺少要删除的路径")
	}

	m.mu.Lock()
	kept := make([]Summary, 0, len(m.history))
	removed := 0
	for _, h := range m.history {
		if normalizeHistoryPath(h.Path) == target {
			removed++
			continue
		}
		kept = append(kept, h)
	}
	if removed == 0 {
		m.mu.Unlock()
		return 0, ErrHistoryNotFound
	}
	m.history = kept
	m.mu.Unlock()

	m.saveHistory()
	return removed, nil
}

// normalizeHistoryPath 统一末尾斜杠，便于按路径匹配历史记录。
func normalizeHistoryPath(p string) string {
	p = strings.TrimSpace(p)
	for len(p) > 1 && strings.HasSuffix(p, "/") {
		p = strings.TrimSuffix(p, "/")
	}
	return p
}

func (m *Manager) History() []Summary {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Summary, len(m.history))
	copy(out, m.history)
	return out
}

// ---------- Job helpers ----------

func (j *Job) Status() string {
	j.mu.RLock()
	defer j.mu.RUnlock()
	return j.status
}

func (j *Job) Tree() *scan.Tree {
	j.mu.RLock()
	defer j.mu.RUnlock()
	return j.tree
}

func (j *Job) Errors() []scan.ScanError {
	j.mu.RLock()
	defer j.mu.RUnlock()
	out := make([]scan.ScanError, len(j.errs))
	copy(out, j.errs)
	return out
}

func (j *Job) FinishedAt() time.Time {
	j.mu.RLock()
	defer j.mu.RUnlock()
	return j.finishedAt
}

func (j *Job) Summary() Summary {
	j.mu.RLock()
	defer j.mu.RUnlock()
	s := Summary{
		ID:        j.ID,
		Path:      j.Root,
		Status:    j.status,
		StartedAt: j.startedAt.UnixMilli(),
		Files:     j.prog.Files.Load(),
		Dirs:      j.prog.Dirs.Load(),
		Size:      j.prog.Size.Load(),
		Alloc:     j.prog.Alloc.Load(),
		Errors:    j.prog.Errors.Load(),
		Truncated: j.truncated,
	}
	if !j.finishedAt.IsZero() {
		s.FinishedAt = j.finishedAt.UnixMilli()
		s.DurationMs = j.finishedAt.Sub(j.startedAt).Milliseconds()
	} else {
		s.DurationMs = time.Since(j.startedAt).Milliseconds()
	}
	if j.errMsg != "" {
		msg := j.errMsg
		s.Error = &msg
	}
	return s
}

// ProgressSnapshot is the live progress payload.
type ProgressSnapshot struct {
	ID          string `json:"id"`
	Status      string `json:"status"`
	Files       int64  `json:"files"`
	Dirs        int64  `json:"dirs"`
	Size        int64  `json:"size"`
	Alloc       int64  `json:"alloc"`
	CurrentPath string `json:"currentPath"`
	ElapsedMs   int64  `json:"elapsedMs"`
	Errors      int64  `json:"errors"`
	Truncated   bool   `json:"truncated"`
}

func (j *Job) Progress() ProgressSnapshot {
	j.mu.RLock()
	st := j.status
	finished := j.finishedAt
	trunc := j.truncated
	j.mu.RUnlock()
	elapsed := time.Since(j.startedAt)
	if !finished.IsZero() {
		elapsed = finished.Sub(j.startedAt)
	}
	return ProgressSnapshot{
		ID:          j.ID,
		Status:      st,
		Files:       j.prog.Files.Load(),
		Dirs:        j.prog.Dirs.Load(),
		Size:        j.prog.Size.Load(),
		Alloc:       j.prog.Alloc.Load(),
		CurrentPath: j.prog.Current(),
		ElapsedMs:   elapsed.Milliseconds(),
		Errors:      j.prog.Errors.Load(),
		Truncated:   trunc,
	}
}

// ---------- history persistence ----------

func (m *Manager) historyPath() string {
	if m.dataDir == "" {
		return ""
	}
	return filepath.Join(m.dataDir, "history.json")
}

func (m *Manager) loadHistory() {
	p := m.historyPath()
	if p == "" {
		return
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return
	}
	var list []Summary
	if err := json.Unmarshal(data, &list); err != nil {
		return
	}
	for i := range list {
		if list[i].Status == StatusRunning {
			list[i].Status = StatusError
			msg := "应用重启，扫描已中断"
			list[i].Error = &msg
		}
	}
	m.history = list
}

func (m *Manager) saveHistory() {
	p := m.historyPath()
	if p == "" {
		return
	}
	m.mu.RLock()
	list := make([]Summary, len(m.history))
	copy(list, m.history)
	m.mu.RUnlock()
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, p)
}

func newID() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("s_%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("s_%d_%s", time.Now().UnixMilli(), hex.EncodeToString(b[:]))
}
