package scan

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// ScanError records one directory that could not be read.
type ScanError struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// Progress is safe for concurrent updates and reads.
type Progress struct {
	Files   atomic.Int64
	Dirs    atomic.Int64
	Size    atomic.Int64
	Alloc   atomic.Int64
	Errors  atomic.Int64
	current atomic.Value
	started time.Time
	done    atomic.Bool
}

func NewProgress() *Progress {
	p := &Progress{started: time.Now()}
	p.current.Store("")
	p.Dirs.Store(1)
	return p
}

func (p *Progress) SetCurrent(s string) { p.current.Store(s) }
func (p *Progress) Current() string {
	if v, ok := p.current.Load().(string); ok {
		return v
	}
	return ""
}
func (p *Progress) ElapsedMs() int64 {
	elapsed := time.Since(p.started)
	if p.done.Load() {
		// keep reporting the stop moment; callers use job duration instead
	}
	return elapsed.Milliseconds()
}

// Options controls a scan.
type Options struct {
	OneFilesystem bool
	MaxNodes      int
	Workers       int
}

func DefaultOptions() Options {
	w := runtime.NumCPU() * 4
	if w < 4 {
		w = 4
	}
	if w > 32 {
		w = 32
	}
	return Options{
		OneFilesystem: true,
		MaxNodes:      4_000_000,
		Workers:       w,
	}
}

type workItem struct {
	idx  int32
	path string
}

var skippedRoots = map[string]bool{
	"/proc": true,
	"/sys":  true,
	"/dev":  true,
	"/run":  true,
}

// blockedPath reports whether the path is a virtual filesystem we refuse to scan.
func blockedPath(p string) bool {
	if skippedRoots[p] {
		return true
	}
	for root := range skippedRoots {
		if len(p) > len(root) && p[:len(root)] == root && p[len(root)] == '/' {
			return true
		}
	}
	return false
}

// Scan walks root and returns a compact tree plus the list of unreadable paths.
func Scan(ctx context.Context, root string, opts Options, prog *Progress) (*Tree, []ScanError, error) {
	root = filepath.Clean(root)
	if !filepath.IsAbs(root) {
		return nil, nil, fmt.Errorf("路径必须是绝对路径")
	}
	if blockedPath(root) {
		return nil, nil, fmt.Errorf("不允许扫描虚拟文件系统目录: %s", root)
	}
	fi, err := os.Lstat(root)
	if err != nil {
		return nil, nil, err
	}
	if !fi.IsDir() {
		return nil, nil, fmt.Errorf("只能扫描目录，不支持单个文件")
	}
	rootDev := devOf(fi)
	mounts := mountPoints()
	name := filepath.Base(root)
	if root == "/" {
		name = "/"
	}
	if opts.MaxNodes <= 0 {
		opts.MaxNodes = 4_000_000
	}
	if opts.Workers <= 0 {
		opts.Workers = DefaultOptions().Workers
	}

	tree := NewTree(root, name, rootDev, opts.MaxNodes)
	tree.Mtime[0] = fi.ModTime().UnixMilli()
	prog.SetCurrent(root)

	var errMu sync.Mutex
	errs := make([]ScanError, 0, 16)
	recordErr := func(path string, err error) {
		prog.Errors.Add(1)
		errMu.Lock()
		if len(errs) < 1000 {
			errs = append(errs, ScanError{Path: path, Error: err.Error()})
		}
		errMu.Unlock()
	}

	level := []workItem{{idx: 0, path: root}}
	for len(level) > 0 {
		if ctx.Err() != nil {
			break
		}
		nextChunks := make([][]workItem, len(level))
		jobs := make(chan int, len(level))
		var wg sync.WaitGroup
		workers := opts.Workers
		if workers > len(level) {
			workers = len(level)
		}
		for w := 0; w < workers; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := range jobs {
					nextChunks[i] = scanDir(ctx, tree, level[i], root, mounts, opts, prog, recordErr)
				}
			}()
		}
		for i := range level {
			jobs <- i
		}
		close(jobs)
		wg.Wait()

		if tree.Truncated || ctx.Err() != nil {
			break
		}
		total := 0
		for _, c := range nextChunks {
			total += len(c)
		}
		if total == 0 {
			break
		}
		next := make([]workItem, 0, total)
		for _, c := range nextChunks {
			next = append(next, c...)
		}
		level = next
	}

	tree.Aggregate()
	tree.Finalize(1000)

	errMu.Lock()
	out := append([]ScanError(nil), errs...)
	errMu.Unlock()
	return tree, out, nil
}

func scanDir(
	ctx context.Context,
	tree *Tree,
	item workItem,
	rootPath string,
	mounts map[string]bool,
	opts Options,
	prog *Progress,
	recordErr func(string, error),
) []workItem {
	if ctx.Err() != nil {
		return nil
	}
	if tree.Len() >= tree.MaxNodes {
		tree.Truncated = true
		return nil
	}
	prog.SetCurrent(item.path)

	f, err := os.Open(item.path)
	if err != nil {
		recordErr(item.path, err)
		return nil
	}
	entries, err := f.ReadDir(-1)
	_ = f.Close()
	if err != nil {
		recordErr(item.path, err)
		return nil
	}
	if len(entries) == 0 {
		return nil
	}

	batch := make([]Candidate, 0, len(entries))
	dirPos := make([]int, 0, 8)
	dirPaths := make([]string, 0, 8)
	var fileN, dirN, sizeSum, allocSum int64

	for _, de := range entries {
		name := de.Name()
		full := item.path + "/" + name
		if item.path == "/" {
			full = "/" + name
		}
		info, ierr := de.Info()
		if ierr != nil {
			recordErr(full, ierr)
			continue
		}
		mode := info.Mode()
		var typ NodeType
		switch {
		case mode.IsDir():
			typ = TypeDir
		case mode&os.ModeSymlink != 0:
			typ = TypeLink
		case mode.IsRegular():
			typ = TypeFile
		default:
			typ = TypeOther
		}
		var size, alloc int64
		var mount bool
		if typ == TypeFile {
			size = info.Size()
			alloc = blocksOf(info)
			fileN++
			sizeSum += size
			allocSum += alloc
		} else if typ == TypeLink {
			fileN++
		} else if typ == TypeDir {
			dirN++
			// Btrfs sub-volumes report a different st_dev while not being
			// separate mounts, so boundary detection must use the real mount
			// table instead of st_dev. Otherwise user directories such as
			// /vol1/1000 would be skipped entirely.
			cleanFull := filepath.Clean(full)
			if opts.OneFilesystem && cleanFull != rootPath && mounts[cleanFull] {
				mount = true
			}
			if !mount && rootPath == "/" && skippedRoots[full] {
				mount = true
			}
		}

		pos := len(batch)
		batch = append(batch, Candidate{
			Name:  name,
			Type:  typ,
			Size:  size,
			Alloc: alloc,
			Mtime: info.ModTime().UnixMilli(),
			Mount: mount,
		})
		if typ == TypeDir && !mount {
			dirPos = append(dirPos, pos)
			dirPaths = append(dirPaths, full)
		}
	}

	ids := tree.AddChildren(item.idx, batch)
	prog.Files.Add(fileN)
	prog.Dirs.Add(dirN)
	prog.Size.Add(sizeSum)
	prog.Alloc.Add(allocSum)

	if len(dirPos) == 0 {
		return nil
	}
	next := make([]workItem, 0, len(dirPos))
	for k, pos := range dirPos {
		if pos < len(ids) {
			next = append(next, workItem{idx: ids[pos], path: dirPaths[k]})
		}
	}
	return next
}

// mountPoints parses /proc/self/mounts and returns the set of mount points.
func mountPoints() map[string]bool {
	out := make(map[string]bool, 64)
	data, err := os.ReadFile("/proc/self/mounts")
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		out[filepath.Clean(unescapeMount(fields[1]))] = true
	}
	return out
}

// unescapeMount decodes the octal escapes (e.g. \040 for space) used in /proc/mounts.
func unescapeMount(s string) string {
	if !strings.Contains(s, "\\") {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) && isOctal(s[i+1]) && isOctal(s[i+2]) && isOctal(s[i+3]) {
			b.WriteByte((s[i+1]-'0')*64 + (s[i+2]-'0')*8 + (s[i+3] - '0'))
			i += 3
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func isOctal(c byte) bool { return c >= '0' && c <= '7' }

func devOf(fi os.FileInfo) uint64 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return uint64(st.Dev)
	}
	return 0
}

func blocksOf(fi os.FileInfo) int64 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return int64(st.Blocks) * 512
	}
	return fi.Size()
}
