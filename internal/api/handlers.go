package api

import (
	"bufio"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"trtree/internal/scan"
	"trtree/internal/sysinfo"
)

// ---------- volumes / browse ----------

func (s *Server) handleVolumes(w http.ResponseWriter, r *http.Request) {
	info := &httpRequestInfo{uid: s.userID(r), user: s.userName(r)}
	vols := sysinfo.Volumes()
	if vols == nil {
		vols = []sysinfo.Volume{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"volumes": vols,
		"roots":   s.buildRoots(info),
		"history": s.jobs.History(),
	})
}

type browseDir struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Mtime    int64  `json:"mtime"`
	Readable bool   `json:"readable"`
}

func (s *Server) handleBrowse(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimSpace(r.URL.Query().Get("path"))
	if p == "" {
		p = "/"
	}
	if !filepath.IsAbs(p) {
		writeErr(w, http.StatusBadRequest, "路径必须是绝对路径")
		return
	}
	p = filepath.Clean(p)
	info := &httpRequestInfo{uid: s.userID(r), user: s.userName(r)}
	resp := map[string]any{
		"path":      p,
		"parent":    parentOf(p),
		"roots":     s.buildRoots(info),
		"dirs":      []browseDir{},
		"truncated": false,
		"error":     nil,
	}
	fi, err := os.Stat(p)
	if err != nil {
		resp["error"] = "无法访问该目录： " + err.Error()
		writeJSON(w, http.StatusOK, resp)
		return
	}
	if !fi.IsDir() {
		resp["error"] = "该路径不是目录"
		writeJSON(w, http.StatusOK, resp)
		return
	}
	f, err := os.Open(p)
	if err != nil {
		resp["error"] = "无权限读取该目录"
		writeJSON(w, http.StatusOK, resp)
		return
	}
	entries, err := f.ReadDir(-1)
	_ = f.Close()
	if err != nil {
		resp["error"] = "读取目录失败： " + err.Error()
		writeJSON(w, http.StatusOK, resp)
		return
	}
	dirs := make([]browseDir, 0, len(entries))
	for _, de := range entries {
		if !de.IsDir() {
			continue
		}
		ei, ierr := de.Info()
		var mt int64
		if ierr == nil {
			mt = ei.ModTime().UnixMilli()
		}
		dirs = append(dirs, browseDir{
			Name:     de.Name(),
			Path:     filepath.Join(p, de.Name()),
			Mtime:    mt,
			Readable: true,
		})
	}
	sort.Slice(dirs, func(i, j int) bool {
		return strings.ToLower(dirs[i].Name) < strings.ToLower(dirs[j].Name)
	})
	truncated := false
	if len(dirs) > 2000 {
		dirs = dirs[:2000]
		truncated = true
	}
	resp["dirs"] = dirs
	resp["truncated"] = truncated
	writeJSON(w, http.StatusOK, resp)
}

func parentOf(p string) string {
	if p == "/" {
		return ""
	}
	d := filepath.Dir(p)
	return d
}

// ---------- scans ----------

func (s *Server) handleStartScan(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path          string `json:"path"`
		OneFilesystem *bool  `json:"oneFilesystem"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "请求体格式错误")
		return
	}
	p, err := validateScanPath(body.Path)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	oneFS := true
	if body.OneFilesystem != nil {
		oneFS = *body.OneFilesystem
	}
	j, err := s.jobs.Start(p, oneFS)
	if err != nil {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"id": j.ID, "status": StatusRunning})
}

func validateScanPath(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", fmt.Errorf("请选择要分析的目录")
	}
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("路径必须是绝对路径")
	}
	p = filepath.Clean(p)
	for _, blocked := range []string{"/proc", "/sys", "/dev", "/run"} {
		if p == blocked || strings.HasPrefix(p, blocked+"/") {
			return "", fmt.Errorf("不支持分析虚拟文件系统目录：%s", p)
		}
	}
	fi, err := os.Stat(p)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("路径不存在：%s", p)
		}
		return "", fmt.Errorf("无法访问路径：%v", err)
	}
	if !fi.IsDir() {
		return "", fmt.Errorf("只能分析目录，不支持单个文件")
	}
	return p, nil
}

func (s *Server) handleListScans(w http.ResponseWriter, r *http.Request) {
	list, active := s.jobs.List()
	if list == nil {
		list = []Summary{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"scans": list, "active": active})
}

func (s *Server) handleGetScan(w http.ResponseWriter, r *http.Request) {
	j := s.jobs.Get(r.PathValue("id"))
	if j == nil {
		writeErr(w, http.StatusNotFound, "扫描任务不存在")
		return
	}
	type detail struct {
		Summary
		Root *NodeDTO `json:"root"`
	}
	d := detail{Summary: j.Summary()}
	if t := j.Tree(); t != nil {
		nd := nodeDTO(t, 0)
		d.Root = &nd
	}
	writeJSON(w, http.StatusOK, d)
}

func (s *Server) handleDeleteScan(w http.ResponseWriter, r *http.Request) {
	if err := s.jobs.Delete(r.PathValue("id")); err != nil {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleDeleteHistory 清除某个路径的历史扫描记录（可按路径批量删）。
func (s *Server) handleDeleteHistory(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if path == "" {
		writeErr(w, http.StatusBadRequest, "缺少路径参数 path")
		return
	}
	removed, err := s.jobs.DeleteHistory(path)
	if err != nil {
		status := http.StatusConflict
		if errors.Is(err, ErrHistoryNotFound) {
			status = http.StatusNotFound
		}
		writeErr(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "removed": removed, "path": path})
}

func (s *Server) handleCancelScan(w http.ResponseWriter, r *http.Request) {
	if err := s.jobs.Cancel(r.PathValue("id")); err != nil {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleProgress(w http.ResponseWriter, r *http.Request) {
	j := s.jobs.Get(r.PathValue("id"))
	if j == nil {
		writeErr(w, http.StatusNotFound, "扫描任务不存在")
		return
	}
	writeJSON(w, http.StatusOK, j.Progress())
}

// ---------- tree / list / search ----------

func queryInt(r *http.Request, key string, def int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func queryNode(r *http.Request) int32 {
	n := queryInt(r, "node", 0)
	return int32(n)
}

func normSort(r *http.Request) (string, string) {
	sortKey := r.URL.Query().Get("sort")
	switch sortKey {
	case "size", "name", "mtime", "alloc", "count":
	default:
		sortKey = "size"
	}
	dir := r.URL.Query().Get("dir")
	if dir != "asc" {
		dir = "desc"
	}
	return sortKey, dir
}

func (s *Server) readyJob(w http.ResponseWriter, r *http.Request) (*Job, bool) {
	j := s.jobs.Get(r.PathValue("id"))
	if j == nil {
		writeErr(w, http.StatusNotFound, "扫描任务不存在")
		return nil, false
	}
	if j.Status() == StatusRunning {
		writeErr(w, http.StatusConflict, "扫描尚未完成")
		return nil, false
	}
	if j.Tree() == nil {
		writeErr(w, http.StatusConflict, "扫描未产生结果")
		return nil, false
	}
	return j, true
}

func (s *Server) handleTree(w http.ResponseWriter, r *http.Request) {
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
	depth := queryInt(r, "depth", 1)
	if depth < 1 {
		depth = 1
	}
	if depth > 3 {
		depth = 3
	}
	limit := queryInt(r, "limit", 2000)
	if limit < 1 {
		limit = 2000
	}
	if limit > 5000 {
		limit = 5000
	}
	sortKey, dir := normSort(r)

	nd := nodeDTO(t, node)
	var children []NodeDTO
	truncated := false
	if nd.Type == "dir" {
		kids := j.sortedChildren(node, sortKey, dir)
		total := len(kids)
		if total > limit {
			kids = kids[:limit]
			truncated = true
		}
		if depth <= 1 {
			children = nodesDTO(t, kids)
		} else {
			children = make([]NodeDTO, 0, len(kids))
			for _, kid := range kids {
				cd, ctrunc := buildSubtree(j, t, kid, depth-1, limit, sortKey, dir)
				truncated = truncated || ctrunc
				children = append(children, cd)
			}
		}
	}
	anc := make([]NodeDTO, 0, 8)
	for _, id := range t.Ancestors(node) {
		anc = append(anc, nodeDTO(t, id))
	}
	resp := map[string]any{
		"node":      nd,
		"children":  children,
		"total":     t.ChildCountOf(node),
		"truncated": truncated,
		"ancestors": anc,
	}
	if children == nil {
		resp["children"] = []NodeDTO{}
	}
	writeJSON(w, http.StatusOK, resp)
}

func buildSubtree(j *Job, t *scan.Tree, id int32, depth, limit int, sortKey, dir string) (NodeDTO, bool) {
	d := nodeDTO(t, id)
	if depth <= 0 || d.Type != "dir" {
		return d, false
	}
	kids := j.sortedChildren(id, sortKey, dir)
	truncated := false
	if len(kids) > limit {
		kids = kids[:limit]
		truncated = true
	}
	d.Children = make([]NodeDTO, 0, len(kids))
	for _, kid := range kids {
		cd, ct := buildSubtree(j, t, kid, depth-1, limit, sortKey, dir)
		truncated = truncated || ct
		d.Children = append(d.Children, cd)
	}
	return d, truncated
}

func (s *Server) handleChildren(w http.ResponseWriter, r *http.Request) {
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
	sortKey, dir := normSort(r)
	offset := queryInt(r, "offset", 0)
	if offset < 0 {
		offset = 0
	}
	limit := queryInt(r, "limit", 100)
	if limit < 1 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	kind := r.URL.Query().Get("kind")
	all := j.sortedChildren(node, sortKey, dir)
	filtered := make([]int32, 0, len(all))
	for _, id := range all {
		if kind == "file" && t.TypeOf(id) == scan.TypeDir {
			continue
		}
		if kind == "dir" && t.TypeOf(id) != scan.TypeDir {
			continue
		}
		if q != "" && !containsFold(t.Name(id), q) {
			continue
		}
		filtered = append(filtered, id)
	}
	total := len(filtered)
	items := []NodeDTO{}
	if offset < total {
		end := offset + limit
		if end > total {
			end = total
		}
		items = nodesDTO(t, filtered[offset:end])
	}
	nd := nodeDTO(t, node)
	writeJSON(w, http.StatusOK, map[string]any{
		"node":   nd,
		"total":  total,
		"offset": offset,
		"limit":  limit,
		"items":  items,
	})
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	j, ok := s.readyJob(w, r)
	if !ok {
		return
	}
	t := j.Tree()
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeErr(w, http.StatusBadRequest, "请输入搜索关键词")
		return
	}
	lower := strings.ToLower(q)
	kind := r.URL.Query().Get("kind")
	minSize := int64(queryInt(r, "minSize", 0))
	limit := queryInt(r, "limit", 200)
	if limit < 1 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}
	const maxMatches = 20000
	ids := make([]int32, 0, 64)
	total := 0
	truncated := false
	for i := 1; i < t.Len(); i++ {
		typ := t.TypeOf(int32(i))
		if kind == "file" && typ == scan.TypeDir {
			continue
		}
		if kind == "dir" && typ != scan.TypeDir {
			continue
		}
		if t.Size[i] < minSize {
			continue
		}
		if !containsFold(t.Names[i], lower) {
			continue
		}
		total++
		if len(ids) < maxMatches {
			ids = append(ids, int32(i))
		} else {
			truncated = true
		}
	}
	sortIDsBySize(t, ids, true)
	if len(ids) > limit {
		ids = ids[:limit]
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"total":     total,
		"truncated": truncated,
		"items":     nodesDTO(t, ids),
	})
}

func (s *Server) handleTop(w http.ResponseWriter, r *http.Request) {
	j, ok := s.readyJob(w, r)
	if !ok {
		return
	}
	t := j.Tree()
	limit := queryInt(r, "limit", 100)
	if limit < 1 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	ids := t.TopFiles
	if len(ids) > limit {
		ids = ids[:limit]
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": nodesDTO(t, ids)})
}

func (s *Server) handleExtensions(w http.ResponseWriter, r *http.Request) {
	j, ok := s.readyJob(w, r)
	if !ok {
		return
	}
	t := j.Tree()
	limit := queryInt(r, "limit", 50)
	if limit < 1 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	var total int64
	for _, st := range t.ExtStats {
		total += st.Size
	}
	stats := t.ExtStats
	if len(stats) > limit {
		stats = stats[:limit]
	}
	type extItem struct {
		Ext   string  `json:"ext"`
		Size  int64   `json:"size"`
		Alloc int64   `json:"alloc"`
		Count int64   `json:"count"`
		Pct   float64 `json:"pct"`
	}
	items := make([]extItem, 0, len(stats))
	for _, st := range stats {
		pct := 0.0
		if total > 0 {
			pct = float64(st.Size) / float64(total)
		}
		items = append(items, extItem{Ext: st.Ext, Size: st.Size, Alloc: st.Alloc, Count: st.Count, Pct: pct})
	}
	if items == nil {
		items = []extItem{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleErrors(w http.ResponseWriter, r *http.Request) {
	j, ok := s.readyJob(w, r)
	if !ok {
		return
	}
	errs := j.Errors()
	offset := queryInt(r, "offset", 0)
	if offset < 0 {
		offset = 0
	}
	limit := queryInt(r, "limit", 100)
	if limit < 1 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	total := len(errs)
	items := []scan.ScanError{}
	if offset < total {
		end := offset + limit
		if end > total {
			end = total
		}
		items = errs[offset:end]
	}
	writeJSON(w, http.StatusOK, map[string]any{"total": total, "items": items})
}

func (s *Server) handleLocate(w http.ResponseWriter, r *http.Request) {
	j, ok := s.readyJob(w, r)
	if !ok {
		return
	}
	t := j.Tree()
	id := queryNode(r)
	if id < 0 || int(id) >= t.Len() {
		writeErr(w, http.StatusNotFound, "节点不存在")
		return
	}
	anc := make([]NodeDTO, 0, 8)
	for _, aid := range t.Ancestors(id) {
		anc = append(anc, nodeDTO(t, aid))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"node":      nodeDTO(t, id),
		"ancestors": anc,
	})
}

// ---------- export ----------

func (s *Server) handleExportCSV(w http.ResponseWriter, r *http.Request) {
	j, ok := s.readyJob(w, r)
	if !ok {
		return
	}
	t := j.Tree()
	kind := r.URL.Query().Get("kind")
	if kind != "files" && kind != "dirs" {
		kind = "all"
	}
	sortKey := r.URL.Query().Get("sort")
	fn := fmt.Sprintf("wizt-%s-%s.csv", sanitizeFilename(filepath.Base(j.Root)), time.Now().Format("20060102-1504"))
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", fn))
	w.WriteHeader(http.StatusOK)

	bw := bufio.NewWriterSize(w, 256*1024)
	bw.WriteString("\uFEFFpath,type,size,alloc,mtime,count\n")
	var walk func(id int32, path string)
	walk = func(id int32, path string) {
		typ := t.TypeOf(id)
		include := kind == "all" || (kind == "files" && typ != scan.TypeDir) || (kind == "dirs" && typ == scan.TypeDir)
		if include {
			mtime := ""
			if t.Mtime[id] > 0 {
				mtime = time.UnixMilli(t.Mtime[id]).Format("2006-01-02 15:04:05")
			}
			bw.WriteString(csvQuote(path))
			bw.WriteByte(',')
			bw.WriteString(typ.String())
			bw.WriteByte(',')
			bw.WriteString(strconv.FormatInt(t.Size[id], 10))
			bw.WriteByte(',')
			bw.WriteString(strconv.FormatInt(t.Alloc[id], 10))
			bw.WriteByte(',')
			bw.WriteString(mtime)
			bw.WriteByte(',')
			bw.WriteString(strconv.FormatUint(uint64(t.DescendantsCount(id)), 10))
			bw.WriteByte('\n')
		}
		if typ != scan.TypeDir {
			return
		}
		kids := t.Children(id)
		if sortKey != "name" {
			sortIDsBySize(t, kids, true)
		} else {
			sort.SliceStable(kids, func(a, b int) bool {
				return strings.ToLower(t.Name(kids[a])) < strings.ToLower(t.Name(kids[b]))
			})
		}
		for _, kid := range kids {
			walk(kid, childPath(path, t.Name(kid)))
		}
	}
	walk(0, t.RootPath)
	bw.Flush()
}

func childPath(parent, name string) string {
	if parent == "/" {
		return "/" + name
	}
	return parent + "/" + name
}

func csvQuote(s string) string {
	if !strings.ContainsAny(s, ",\"\n\r") {
		return s
	}
	return "\"" + strings.ReplaceAll(s, "\"", "\"\"") + "\""
}

func (s *Server) handleExportJSON(w http.ResponseWriter, r *http.Request) {
	j, ok := s.readyJob(w, r)
	if !ok {
		return
	}
	t := j.Tree()
	kids := j.sortedChildren(0, "size", "desc")
	if len(kids) > 5000 {
		kids = kids[:5000]
	}
	top := t.TopFiles
	if len(top) > 1000 {
		top = top[:1000]
	}
	var totalFileSize int64
	for _, st := range t.ExtStats {
		totalFileSize += st.Size
	}
	type extItem struct {
		Ext   string  `json:"ext"`
		Size  int64   `json:"size"`
		Alloc int64   `json:"alloc"`
		Count int64   `json:"count"`
		Pct   float64 `json:"pct"`
	}
	exts := make([]extItem, 0, len(t.ExtStats))
	for _, st := range t.ExtStats {
		p := 0.0
		if totalFileSize > 0 {
			p = float64(st.Size) / float64(totalFileSize)
		}
		exts = append(exts, extItem{Ext: st.Ext, Size: st.Size, Alloc: st.Alloc, Count: st.Count, Pct: p})
	}
	fn := fmt.Sprintf("wizt-%s-%s.json", sanitizeFilename(filepath.Base(j.Root)), time.Now().Format("20060102-1504"))
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", fn))
	writeJSON(w, http.StatusOK, map[string]any{
		"root":       nodeDTO(t, 0),
		"summary":    j.Summary(),
		"children":   nodesDTO(t, kids),
		"extensions": exts,
		"topFiles":   nodesDTO(t, top),
	})
}

// containsFold is an ASCII-case-insensitive substring search that does not allocate.
// lowerQ must already be lowercase. For UTF-8 (e.g. Chinese) it degrades to a byte
// substring match, which is what we want.
func containsFold(s, lowerQ string) bool {
	n := len(lowerQ)
	if n == 0 {
		return true
	}
	if len(s) < n {
		return false
	}
	first := lowerQ[0]
	for i := 0; i+n <= len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		if c != first {
			continue
		}
		match := true
		for j := 1; j < n; j++ {
			c2 := s[i+j]
			if c2 >= 'A' && c2 <= 'Z' {
				c2 += 'a' - 'A'
			}
			if c2 != lowerQ[j] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
