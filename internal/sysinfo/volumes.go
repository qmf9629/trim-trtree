package sysinfo

import (
	"bufio"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

// Volume describes one mount point suitable for scanning.
type Volume struct {
	ID         string `json:"id"`
	Label      string `json:"label"`
	Path       string `json:"path"`
	FS         string `json:"fs"`
	Device     string `json:"device"`
	Total      uint64 `json:"total"`
	Used       uint64 `json:"used"`
	Free       uint64 `json:"free"`
	System     bool   `json:"system"`
	Accessible bool   `json:"accessible"`
}

var allowedFS = map[string]bool{
	"ext2": true, "ext3": true, "ext4": true,
	"btrfs": true, "xfs": true, "f2fs": true, "jfs": true, "reiserfs": true,
	"vfat": true, "exfat": true, "ntfs": true, "ntfs3": true, "fuseblk": true,
	"cifs": true, "smb3": true, "nfs": true, "nfs4": true, "zfs": true,
}

// Volumes returns real block/network filesystems, deduplicated by backing device
// (btrfs sub-volumes share one device) and by mount point.
func Volumes() []Volume {
	f, err := os.Open("/proc/mounts")
	if err != nil {
		return nil
	}
	defer f.Close()

	seenMount := make(map[string]bool)
	byDev := make(map[string]Volume)
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 3 {
			continue
		}
		dev := unescapeMount(fields[0])
		mnt := unescapeMount(fields[1])
		fsType := fields[2]
		if !allowedFS[fsType] {
			continue
		}
		if seenMount[mnt] {
			continue
		}
		if mnt == "/boot" || strings.HasPrefix(mnt, "/boot/") {
			continue
		}
		if strings.HasPrefix(mnt, "/snap/") || strings.HasPrefix(mnt, "/var/lib/docker/") {
			continue
		}
		seenMount[mnt] = true

		v := Volume{
			ID:     mnt,
			Path:   mnt,
			FS:     fsType,
			Device: dev,
			System: mnt == "/",
			Label:  labelFor(mnt),
		}
		var st syscall.Statfs_t
		if err := syscall.Statfs(mnt, &st); err == nil {
			bs := uint64(st.Bsize)
			v.Total = st.Blocks * bs
			free := st.Bavail * bs
			v.Free = free
			if v.Total > free {
				v.Used = v.Total - free
			}
		}
		if _, err := os.Stat(mnt); err == nil {
			v.Accessible = true
		}

		key := dev
		if key == "" {
			key = mnt
		}
		if prev, ok := byDev[key]; ok {
			if volumeScore(v.Path) >= volumeScore(prev.Path) {
				continue
			}
		}
		byDev[key] = v
	}

	out := make([]Volume, 0, len(byDev))
	for _, v := range byDev {
		out = append(out, v)
	}

	sort.SliceStable(out, func(i, j int) bool {
		ai, aj := volumeRank(out[i].Path), volumeRank(out[j].Path)
		if ai != aj {
			return ai < aj
		}
		return out[i].Path < out[j].Path
	})
	return out
}

// volumeScore prefers the canonical mount of a device: /volN, then /, then short paths.
func volumeScore(p string) int {
	if strings.HasPrefix(p, "/vol") && isDigits(strings.TrimPrefix(p, "/vol")) {
		return 0
	}
	if p == "/" {
		return 1
	}
	return 10 + len(p)
}

func volumeRank(p string) int {
	if p == "/" {
		return 2
	}
	if strings.HasPrefix(p, "/vol") {
		return 0
	}
	return 1
}

func labelFor(p string) string {
	if p == "/" {
		return "系统盘"
	}
	base := filepath.Base(p)
	if strings.HasPrefix(p, "/vol") && isDigits(strings.TrimPrefix(p, "/vol")) {
		return "存储空间 " + strings.TrimPrefix(p, "/vol")
	}
	if base == "" || base == "." {
		return p
	}
	return base
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	_, err := strconv.Atoi(s)
	return err == nil
}

func unescapeMount(s string) string {
	if !strings.ContainsRune(s, '\\') {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			v, err := strconv.ParseUint(s[i+1:i+4], 8, 8)
			if err == nil {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}
