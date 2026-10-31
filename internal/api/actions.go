package api

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"

	"trtree/internal/scan"
)

// This file implements the two destructive/interactive node actions:
//
//   GET    /api/scans/{id}/open?node=N   → a fnOS "文件管理器" deep link for the node
//   DELETE /api/scans/{id}/nodes?node=N  → permanently delete the node on disk
//
// Both operate on paths taken from the scan tree only (never on a path supplied
// by the client), so a request can only touch a file that was actually scanned.

// fnOS 文件管理器必须通过桌面壳（Trim App）的 openFileManager(path) 桥接唤起，
// 没有任何可用的普通 URL 深链。前端拿到绝对路径后调用宿主 API 即可，
// 这里只负责把扫描节点映射成"应打开的绝对目录"。
const fileManagerApp = "files"

// adminViews lists the fnOS file-manager entries that need admin privileges:
// files owned by *another* user (volN/<otherUid>/…) and team libraries
// (volN/@team/…). Everything else opens in the normal user view.
//
// This mirrors the desktop shell's own routing (see the `uQ` helper of the fnOS
// web shell): a path under volN/<uid>/ opens "我的文件" for that user, while a
// foreign uid or a team dir is only reachable through the all-files view.
const (
	viewUser  = "user"
	viewAdmin = "admin"
)

// needAdminView reports whether opening dir requires the admin (all-files) view.
func needAdminView(dir string, uid int64) bool {
	parts := strings.Split(strings.TrimPrefix(path.Clean(dir), "/"), "/")
	if len(parts) < 2 || !isVolName(parts[0]) {
		return false
	}
	// volN/@team/… → 团队文件
	if parts[1] == "@team" {
		return true
	}
	// volN/<uid>/… → 自己的共享目录走用户视角，别人的才需要管理员视角
	if owner, err := strconv.ParseInt(parts[1], 10, 64); err == nil && owner > 0 {
		return uid > 0 && owner != uid
	}
	// volN/@appshare、volN/@appdata 等系统目录普通用户看不到
	return strings.HasPrefix(parts[1], "@")
}

// handleOpen returns where the fnOS 文件管理器 should be pointed at for this
// node, and which view (user / admin) that directory needs.
func (s *Server) handleOpen(w http.ResponseWriter, r *http.Request) {
	j, ok := s.readyJob(w, r)
	if !ok {
		return
	}
	t := j.Tree()
	n, ok := s.lookupNode(w, t, queryNode(r))
	if !ok {
		return
	}

	targetDir := n.Path
	if n.Type != "dir" {
		targetDir = path.Dir(n.Path)
	}
	inVol := volRelative(targetDir) != ""
	uid := s.currentUID(r)
	view := viewUser
	if needAdminView(targetDir, uid) {
		view = viewAdmin
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path":     n.Path,
		"type":     n.Type,
		"dir":      targetDir,
		"openable": inVol,
		"app":      fileManagerApp,
		"view":     view,
		"admin":    view == viewAdmin,
		"uid":      uid,
	})
}

// currentUID returns the numeric fnOS user id of the caller (0 when unknown,
// e.g. local development without gateway headers).
func (s *Server) currentUID(r *http.Request) int64 {
	raw := strings.TrimSpace(s.userID(r))
	if raw == "" {
		return 0
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id < 0 {
		return 0
	}
	return id
}

// volRelative reports whether p lives under a fnOS storage volume (/volN/...).
func volRelative(p string) string {
	clean := path.Clean(p)
	parts := strings.Split(strings.TrimPrefix(clean, "/"), "/")
	if len(parts) < 2 || !isVolName(parts[0]) {
		return ""
	}
	return strings.Join(parts, "/")
}

func isVolName(s string) bool {
	if len(s) < 4 || !strings.HasPrefix(s, "vol") {
		return false
	}
	for _, r := range s[3:] {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// escapeSegment percent-encodes a string for use inside a URL query value.
func escapeSegment(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		default:
			const hex = "0123456789ABCDEF"
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&0x0f])
		}
	}
	return b.String()
}

// handleDelete permanently removes the node (file or directory tree) and
// invalidates the cached scan so the UI re-scans afterwards.
func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	j, ok := s.readyJob(w, r)
	if !ok {
		return
	}
	t := j.Tree()
	id := queryNode(r)
	n, ok := s.lookupNode(w, t, id)
	if !ok {
		return
	}

	if id == 0 {
		writeErr(w, http.StatusForbidden, "不能删除扫描根目录")
		return
	}
	if n.Path == "" || n.Path == "/" || n.Path == t.RootPath {
		writeErr(w, http.StatusForbidden, "不能删除扫描根目录")
		return
	}
	if strings.Count(strings.Trim(n.Path, "/"), "/") == 0 && isVolName(strings.Trim(n.Path, "/")) {
		writeErr(w, http.StatusForbidden, "不能删除存储空间根目录")
		return
	}
	// Guard against deleting fnOS system areas.
	for _, bad := range []string{"/@", "/docker/rootfs", "/@appdata", "/@appcenter", "/@appmeta", "/@sysappmeta"} {
		if strings.Contains(n.Path, bad) {
			writeErr(w, http.StatusForbidden, "该路径属于系统保留目录，禁止删除")
			return
		}
	}

	var err error
	if n.Type == "dir" {
		err = os.RemoveAll(n.Path)
	} else {
		err = os.Remove(n.Path)
	}
	if err != nil {
		switch {
		case errors.Is(err, fs.ErrNotExist):
			writeErr(w, http.StatusNotFound, "文件已不存在（可能已被移动或删除）")
		case errors.Is(err, fs.ErrPermission):
			writeErr(w, http.StatusForbidden, "没有权限删除该条目")
		default:
			writeErr(w, http.StatusInternalServerError, "删除失败："+err.Error())
		}
		return
	}

	// The tree is now stale: drop the cached scan so the UI must re-analyze.
	s.jobs.Delete(j.ID)

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":           true,
		"id":           id,
		"path":         n.Path,
		"type":         n.Type,
		"size":         n.Size,
		"alloc":        n.Alloc,
		"rescanNeeded": true,
	})
}

// lookupNode validates id against the tree and returns its DTO.
func (s *Server) lookupNode(w http.ResponseWriter, t *scan.Tree, id int32) (NodeDTO, bool) {
	if id < 0 || int(id) >= t.Len() {
		writeErr(w, http.StatusNotFound, "节点不存在")
		return NodeDTO{}, false
	}
	return nodeDTO(t, id), true
}
