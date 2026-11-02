package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func testServer(t *testing.T, allowAll bool) (*httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	srv := New(Config{
		Version:       "test",
		DataDir:       filepath.Join(dir, "data"),
		GatewayPrefix: "/app/wizt",
		AllowAll:      allowAll,
		MaxScanNodes:  100000,
	})
	ts := httptest.NewServer(srv)
	t.Cleanup(ts.Close)
	return ts, dir
}

func getJSON(t *testing.T, url string, out any) *http.Response {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatalf("decode %s: %v", url, err)
		}
	}
	return resp
}

func TestAdminGate(t *testing.T) {
	ts, _ := testServer(t, false)
	// Gateway identity present but not admin -> 403
	req, _ := http.NewRequest("GET", ts.URL+"/api/volumes", nil)
	req.Header.Set("X-Trim-Userid", "1000")
	req.Header.Set("X-Trim-Isadmin", "false")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
	// Admin -> 200
	req2, _ := http.NewRequest("GET", ts.URL+"/api/volumes", nil)
	req2.Header.Set("X-Trim-Userid", "1000")
	req2.Header.Set("X-Trim-Isadmin", "true")
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp2.StatusCode)
	}
}

func TestGatewayRequired(t *testing.T) {
	dir := t.TempDir()
	srv := New(Config{
		Version:        "test",
		DataDir:        filepath.Join(dir, "data"),
		GatewayPrefix:  "/app/wizt",
		MaxScanNodes:   1000,
		RequireGateway: true,
	})
	ts := httptest.NewServer(srv)
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/volumes")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 without gateway identity", resp.StatusCode)
	}
	req, _ := http.NewRequest("GET", ts.URL+"/api/volumes", nil)
	req.Header.Set("X-Trim-Userid", "1000")
	req.Header.Set("X-Trim-Isadmin", "true")
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != 200 {
		t.Fatalf("status = %d, want 200 with admin identity", resp2.StatusCode)
	}
}

func TestScanLifecycle(t *testing.T) {
	ts, dir := testServer(t, true)
	root := filepath.Join(dir, "root")
	os.MkdirAll(filepath.Join(root, "videos"), 0o755)
	os.MkdirAll(filepath.Join(root, "docs"), 0o755)
	os.WriteFile(filepath.Join(root, "videos", "movie.mp4"), make([]byte, 5000), 0o644)
	os.WriteFile(filepath.Join(root, "docs", "a.pdf"), make([]byte, 1000), 0o644)
	os.WriteFile(filepath.Join(root, "readme.txt"), make([]byte, 100), 0o644)

	body := strings.NewReader(`{"path":` + strconvQuote(root) + `}`)
	resp, err := http.Post(ts.URL+"/api/scans", "application/json", body)
	if err != nil {
		t.Fatal(err)
	}
	var start struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&start); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if start.ID == "" {
		t.Fatalf("no scan id: %+v", start)
	}

	var status struct {
		Status string `json:"status"`
	}
	for i := 0; i < 100; i++ {
		getJSON(t, ts.URL+"/api/scans/"+start.ID+"/progress", &status)
		if status.Status != "running" {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if status.Status != "done" {
		t.Fatalf("scan status = %q", status.Status)
	}

	var tree struct {
		Node     NodeDTO   `json:"node"`
		Children []NodeDTO `json:"children"`
		Total    int       `json:"total"`
	}
	getJSON(t, ts.URL+"/api/scans/"+start.ID+"/tree?node=0&depth=1", &tree)
	if tree.Node.Size != 6100 {
		t.Fatalf("root size = %d", tree.Node.Size)
	}
	if tree.Total != 3 || len(tree.Children) != 3 {
		t.Fatalf("children = %d total=%d", len(tree.Children), tree.Total)
	}
	if tree.Children[0].Name != "videos" {
		t.Fatalf("first child = %s, want videos", tree.Children[0].Name)
	}

	var children struct {
		Total int       `json:"total"`
		Items []NodeDTO `json:"items"`
	}
	getJSON(t, ts.URL+"/api/scans/"+start.ID+"/children?node=0&kind=file", &children)
	if children.Total != 1 || children.Items[0].Name != "readme.txt" {
		t.Fatalf("file children = %+v", children)
	}

	var tree2 struct {
		Children []NodeDTO `json:"children"`
	}
	getJSON(t, ts.URL+"/api/scans/"+start.ID+"/tree?node=0&depth=2&limit=10", &tree2)
	if len(tree2.Children) != 3 || len(tree2.Children[0].Children) == 0 {
		t.Fatalf("depth=2 tree missing grandchildren: %+v", tree2.Children)
	}
	if tree2.Children[0].Children[0].Type != "file" {
		t.Fatalf("expected file grandchild, got %+v", tree2.Children[0].Children[0])
	}

	var tm struct {
		Node     NodeDTO       `json:"node"`
		Children []TreemapNode `json:"children"`
		Nodes    int           `json:"nodes"`
	}
	getJSON(t, ts.URL+"/api/scans/"+start.ID+"/treemap?node=0&area=200000", &tm)
	if tm.Node.Size != 6100 || len(tm.Children) != 3 || tm.Nodes != 5 {
		t.Fatalf("treemap root = %+v children=%d nodes=%d", tm.Node, len(tm.Children), tm.Nodes)
	}
	if tm.Children[0].Name != "videos" || len(tm.Children[0].Children) != 1 ||
		tm.Children[0].Children[0].Name != "movie.mp4" || tm.Children[0].Children[0].Ext != "mp4" {
		t.Fatalf("treemap nesting = %+v", tm.Children[0])
	}

	// 预算只够 3 个节点时只展开第一层
	var tmSmall struct {
		Children  []TreemapNode `json:"children"`
		BudgetHit bool          `json:"budgetHit"`
	}
	getJSON(t, ts.URL+"/api/scans/"+start.ID+"/treemap?node=0&budget=3", &tmSmall)
	if len(tmSmall.Children) != 3 || len(tmSmall.Children[0].Children) != 0 || !tmSmall.BudgetHit {
		t.Fatalf("treemap budget = %+v", tmSmall)
	}

	var jsonResp struct {
		Root       NodeDTO   `json:"root"`
		Children   []NodeDTO `json:"children"`
		Extensions []struct {
			Ext string `json:"ext"`
		} `json:"extensions"`
	}
	getJSON(t, ts.URL+"/api/scans/"+start.ID+"/export.json", &jsonResp)
	if jsonResp.Root.Size != 6100 || len(jsonResp.Children) != 3 || len(jsonResp.Extensions) == 0 {
		t.Fatalf("json export = %+v", jsonResp)
	}

	var search struct {
		Total int       `json:"total"`
		Items []NodeDTO `json:"items"`
	}
	getJSON(t, ts.URL+"/api/scans/"+start.ID+"/search?q=MOVIE", &search)
	if search.Total != 1 || search.Items[0].Ext != "mp4" {
		t.Fatalf("search = %+v", search)
	}

	var top struct {
		Items []NodeDTO `json:"items"`
	}
	getJSON(t, ts.URL+"/api/scans/"+start.ID+"/top?limit=10", &top)
	if len(top.Items) != 3 || top.Items[0].Size != 5000 {
		t.Fatalf("top = %+v", top.Items)
	}

	var ext struct {
		Items []struct {
			Ext  string  `json:"ext"`
			Size int64   `json:"size"`
			Pct  float64 `json:"pct"`
		} `json:"items"`
	}
	getJSON(t, ts.URL+"/api/scans/"+start.ID+"/extensions", &ext)
	if len(ext.Items) == 0 || ext.Items[0].Ext != "mp4" {
		t.Fatalf("extensions = %+v", ext.Items)
	}

	resp, err = http.Get(ts.URL + "/api/scans/" + start.ID + "/export?kind=files")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Fatalf("content-type = %q", ct)
	}
	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	csv := string(buf[:n])
	if !strings.Contains(csv, "readme.txt") || !strings.Contains(csv, "movie.mp4") {
		t.Fatalf("csv missing rows:\n%s", csv)
	}
	if strings.Contains(csv, ",dir,") {
		t.Fatalf("files export should not contain dirs:\n%s", csv)
	}
}

func TestStartScanValidation(t *testing.T) {
	ts, _ := testServer(t, true)
	for _, body := range []string{
		`{"path":"relative/path"}`,
		`{"path":"/proc"}`,
		`{"path":"/does/not/exist"}`,
	} {
		resp, err := http.Post(ts.URL+"/api/scans", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("body %s -> status %d, want 400", body, resp.StatusCode)
		}
	}
}

func strconvQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func startTestScan(t *testing.T, ts *httptest.Server, root string) string {
	t.Helper()
	body := strings.NewReader(`{"path":` + strconvQuote(root) + `}`)
	resp, err := http.Post(ts.URL+"/api/scans", "application/json", body)
	if err != nil {
		t.Fatal(err)
	}
	var start struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&start); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	var status struct {
		Status string `json:"status"`
	}
	for i := 0; i < 200; i++ {
		getJSON(t, ts.URL+"/api/scans/"+start.ID+"/progress", &status)
		if status.Status != "running" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status.Status != "done" {
		t.Fatalf("scan status = %q", status.Status)
	}
	return start.ID
}

func TestNeedAdminView(t *testing.T) {
	const me = 1000
	tests := []struct {
		dir  string
		uid  int64
		want bool
		why  string
	}{
		{"/vol1/1000/Photos", me, false, "自己的共享目录 → 用户视角"},
		{"/vol1/1000", me, false, "自己共享根 → 用户视角"},
		{"/vol1/1000/Photos", 0, false, "未知 uid 不升级为管理员"},
		{"/vol1/1001/Docs", me, true, "别人的共享目录 → 管理员视角"},
		{"/vol1/1001", me, true, "别人的共享根 → 管理员视角"},
		{"/vol1/@team/dev", me, true, "团队文件 → 管理员视角"},
		{"/vol1/@appshare/trtree", me, true, "应用共享 → 管理员视角"},
		{"/vol1/@appdata/trtree", me, true, "系统目录 → 管理员视角"},
		{"/tmp/whatever", me, false, "非 /volN 路径不涉及视角"},
		{"/usr/share", me, false, "系统路径不涉及视角"},
		{"/vol1", me, false, "存储空间根由卷视图处理"},
	}
	for _, tc := range tests {
		if got := needAdminView(tc.dir, tc.uid); got != tc.want {
			t.Errorf("needAdminView(%q, %d) = %v, want %v (%s)", tc.dir, tc.uid, got, tc.want, tc.why)
		}
	}
}

func TestOpenShareURL(t *testing.T) {
	tests := []struct {
		in string
		ok bool
	}{
		{"/vol1/1000/Photos/a.jpg", true},
		{"/vol2/Media/movies/x y.mkv", true},
		{"/vol1/1000", true},
		{"/vol1", false},
		{"/usr/lib", false},
		{"/", false},
	}
	for _, tc := range tests {
		if got := volRelative(tc.in) != ""; got != tc.ok {
			t.Errorf("volRelative(%q) ok = %v, want %v", tc.in, got, tc.ok)
		}
	}
	if got := volRelative("/vol1/1000/Photos"); got != "vol1/1000/Photos" {
		t.Errorf("volRelative = %q", got)
	}
	if got := escapeSegment("/vol1/1000/Photos"); got != "%2Fvol1%2F1000%2FPhotos" {
		t.Errorf("escapeSegment = %q", got)
	}
}

func TestDeleteNode(t *testing.T) {
	ts, dir := testServer(t, true)
	root := filepath.Join(dir, "root")
	os.MkdirAll(filepath.Join(root, "sub"), 0o755)
	victim := filepath.Join(root, "victim.txt")
	os.WriteFile(victim, make([]byte, 1234), 0o644)
	os.WriteFile(filepath.Join(root, "keep.txt"), make([]byte, 10), 0o644)
	os.WriteFile(filepath.Join(root, "sub", "nested.bin"), make([]byte, 10), 0o644)

	sid := startTestScan(t, ts, root)

	var children struct {
		Items []NodeDTO `json:"items"`
	}
	getJSON(t, ts.URL+"/api/scans/"+sid+"/children?node=0&kind=file", &children)
	var victimID int32 = -1
	for _, n := range children.Items {
		if n.Name == "victim.txt" {
			victimID = n.ID
			if n.ParentID != 0 {
				t.Fatalf("parentId = %d, want 0", n.ParentID)
			}
		}
	}
	if victimID < 0 {
		t.Fatalf("victim.txt not found in %+v", children.Items)
	}

	// Deleting the scan root must be refused.
	req, _ := http.NewRequest("DELETE", ts.URL+"/api/scans/"+sid+"/nodes?node=0", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("delete root status = %d, want 403", resp.StatusCode)
	}

	req2, _ := http.NewRequest("DELETE", ts.URL+"/api/scans/"+sid+"/nodes?node="+itoa(int(victimID)), nil)
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	var del struct {
		OK           bool   `json:"ok"`
		Path         string `json:"path"`
		RescanNeeded bool   `json:"rescanNeeded"`
	}
	json.NewDecoder(resp2.Body).Decode(&del)
	resp2.Body.Close()
	if resp2.StatusCode != 200 || !del.OK || del.Path != victim {
		t.Fatalf("delete response %d %+v", resp2.StatusCode, del)
	}
	if _, err := os.Stat(victim); !os.IsNotExist(err) {
		t.Fatalf("victim still exists: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "keep.txt")); err != nil {
		t.Fatalf("keep.txt removed: %v", err)
	}
	// The stale scan must be dropped.
	if resp := getJSON(t, ts.URL+"/api/scans/"+sid, nil); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("scan still present: %d", resp.StatusCode)
	}
}

func TestOpenEndpoint(t *testing.T) {
	ts, dir := testServer(t, true)
	base := filepath.Join(dir, "vol1", "1000")
	root := filepath.Join(base, "Photos")
	os.MkdirAll(root, 0o755)
	file := filepath.Join(root, "img.jpg")
	os.WriteFile(file, make([]byte, 100), 0o644)

	// The scan runs on the share subtree, but on a real fnOS the node lives at
	// /volN/<share>/…; emulate that by scanning from a synthetic /volN layout.
	sid := startTestScan(t, ts, base)
	var tree struct {
		Children []NodeDTO `json:"children"`
	}
	getJSON(t, ts.URL+"/api/scans/"+sid+"/tree?node=0&depth=1&limit=10", &tree)
	var photosID int32 = -1
	for _, c := range tree.Children {
		if c.Name == "Photos" {
			photosID = c.ID
		}
	}
	if photosID < 0 {
		t.Fatalf("Photos not found: %+v", tree.Children)
	}
	var kids struct {
		Items []NodeDTO `json:"items"`
	}
	getJSON(t, ts.URL+"/api/scans/"+sid+"/children?node="+itoa(int(photosID)), &kids)
	var fileID int32 = -1
	for _, k := range kids.Items {
		if k.Name == "img.jpg" {
			fileID = k.ID
			if k.ParentID != photosID {
				t.Fatalf("file parentId = %d, want %d", k.ParentID, photosID)
			}
		}
	}
	if fileID < 0 {
		t.Fatal("img.jpg not found")
	}

	var open struct {
		Openable bool   `json:"openable"`
		Dir      string `json:"dir"`
		Path     string `json:"path"`
		Type     string `json:"type"`
	}
	getJSON(t, ts.URL+"/api/scans/"+sid+"/open?node="+itoa(int(fileID)), &open)
	// The temp dir does not sit under /volN, so openable must be false while the
	// containing directory is still returned (the UI then falls back to copying).
	// /vol1/1000 是普通临时目录（未真正挂载为 /volN），因此 openable=false，
	// 但所在目录仍需正确返回，前端据此降级为复制路径。
	if open.Openable || open.Dir != root {
		t.Fatalf("open = %+v", open)
	}
	if open.Type != "file" || !strings.HasSuffix(open.Path, "/Photos/img.jpg") {
		t.Fatalf("open node = %+v", open)
	}
}

func itoa(n int) string {
	return strconv.FormatInt(int64(n), 10)
}

// ---------- 历史记录删除 ----------

func historyPaths(t *testing.T, ts *httptest.Server) []string {
	t.Helper()
	var vols struct {
		History []Summary `json:"history"`
	}
	getJSON(t, ts.URL+"/api/volumes", &vols)
	out := make([]string, 0, len(vols.History))
	for _, h := range vols.History {
		out = append(out, h.Path)
	}
	return out
}

// waitHistory 等待历史记录写入（扫描结束后到写历史之间有一个很短的时间窗）。
func waitHistory(t *testing.T, ts *httptest.Server, path string, want int) {
	t.Helper()
	for i := 0; i < 200; i++ {
		n := 0
		for _, p := range historyPaths(t, ts) {
			if p == path {
				n++
			}
		}
		if n >= want {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("等不到 %d 条 %s 的历史记录，当前 %v", want, path, historyPaths(t, ts))
}

func TestDeleteHistory(t *testing.T) {
	ts, dir := testServer(t, true)
	root := filepath.Join(dir, "hroot")
	os.MkdirAll(filepath.Join(root, "sub"), 0o755)
	os.WriteFile(filepath.Join(root, "a.txt"), make([]byte, 100), 0o644)
	os.WriteFile(filepath.Join(root, "sub", "b.bin"), make([]byte, 50), 0o644)

	// 同一路径扫两次，确认一次删除会清掉该路径下的全部记录
	startTestScan(t, ts, root)
	waitHistory(t, ts, root, 1)
	startTestScan(t, ts, root)
	waitHistory(t, ts, root, 2)

	if got := historyPaths(t, ts); len(got) != 2 {
		t.Fatalf("历史条数 = %d, want 2 (%v)", len(got), got)
	}

	// 尾斜杠也应能匹配
	req, _ := http.NewRequest("DELETE", ts.URL+"/api/history?path="+url.QueryEscape(root+"/"), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var del struct {
		OK      bool `json:"ok"`
		Removed int  `json:"removed"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&del); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !del.OK || del.Removed != 2 {
		t.Fatalf("delete history status=%d ok=%v removed=%d, want 200/true/2",
			resp.StatusCode, del.OK, del.Removed)
	}

	// 接口层面已经没有了
	for _, p := range historyPaths(t, ts) {
		if normalizeHistoryPath(p) == normalizeHistoryPath(root) {
			t.Fatalf("删除后仍存在历史记录：%s", p)
		}
	}

	// 落地文件也必须同步（重启后不能复活）
	raw, err := os.ReadFile(filepath.Join(dir, "data", "history.json"))
	if err != nil {
		t.Fatalf("读取 history.json: %v", err)
	}
	if strings.Contains(string(raw), root) {
		t.Fatalf("history.json 仍包含已删除路径：%s", raw)
	}

	// 再删一次应当 404
	req2, _ := http.NewRequest("DELETE", ts.URL+"/api/history?path="+url.QueryEscape(root), nil)
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("重复删除 status = %d, want 404", resp2.StatusCode)
	}
}

func TestDeleteHistoryBadRequest(t *testing.T) {
	ts, _ := testServer(t, true)
	req, _ := http.NewRequest("DELETE", ts.URL+"/api/history", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("缺少 path 时 status = %d, want 400", resp.StatusCode)
	}
}

func TestNormalizeHistoryPath(t *testing.T) {
	tests := map[string]string{
		"/vol1/1000":    "/vol1/1000",
		"/vol1/1000/":   "/vol1/1000",
		"/vol1/1000///": "/vol1/1000",
		"/":             "/",
		"  /vol2/a  ":   "/vol2/a",
		"":              "",
	}
	for in, want := range tests {
		if got := normalizeHistoryPath(in); got != want {
			t.Errorf("normalizeHistoryPath(%q) = %q, want %q", in, got, want)
		}
	}
}
