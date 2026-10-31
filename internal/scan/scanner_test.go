package scan

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	data := make([]byte, size)
	for i := range data {
		data[i] = 'x'
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestScanTree(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "a.txt"), 100)
	writeFile(t, filepath.Join(root, "sub", "b.bin"), 200)
	if err := os.MkdirAll(filepath.Join(root, "sub", "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "a.txt"), filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}

	prog := NewProgress()
	tree, errs, err := Scan(context.Background(), root, DefaultOptions(), prog)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	// root, a.txt, sub, b.bin, empty, link
	if tree.Len() != 6 {
		t.Fatalf("len = %d, want 6", tree.Len())
	}
	if tree.Size[0] != 300 {
		t.Fatalf("root size = %d, want 300", tree.Size[0])
	}
	if got := tree.DescendantsCount(0); got != 5 {
		t.Fatalf("root count = %d, want 5", got)
	}
	if got := prog.Files.Load(); got != 3 {
		t.Fatalf("files = %d, want 3", got)
	}
	if got := prog.Dirs.Load(); got != 3 {
		t.Fatalf("dirs = %d, want 3", got)
	}
	if len(tree.ExtStats) < 2 {
		t.Fatalf("ext stats missing: %+v", tree.ExtStats)
	}
	if len(tree.TopFiles) != 2 || tree.Size[tree.TopFiles[0]] != 200 {
		t.Fatalf("top files wrong: %v", tree.TopFiles)
	}
	if p := tree.Path(tree.TopFiles[0]); p != filepath.Join(root, "sub", "b.bin") {
		t.Fatalf("path = %q", p)
	}
	if anc := tree.Ancestors(tree.TopFiles[0]); len(anc) != 2 || anc[0] != 0 {
		t.Fatalf("ancestors = %v", anc)
	}
}

func TestScanPermissionError(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root, permission errors cannot be simulated")
	}
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "ok.txt"), 10)
	secret := filepath.Join(root, "secret")
	if err := os.MkdirAll(secret, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(secret, "hidden.txt"), 20)
	if err := os.Chmod(secret, 0o000); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(secret, 0o755)

	prog := NewProgress()
	_, errs, err := Scan(context.Background(), root, DefaultOptions(), prog)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(errs) == 0 {
		t.Fatalf("expected at least one permission error")
	}
	if prog.Errors.Load() == 0 {
		t.Fatalf("error counter not updated")
	}
}

func TestScanCancelled(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "x", "f"), 1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	prog := NewProgress()
	tree, _, err := Scan(ctx, root, DefaultOptions(), prog)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if tree.Len() != 1 {
		t.Fatalf("cancelled scan should only have root, got %d", tree.Len())
	}
}

func TestExtOf(t *testing.T) {
	cases := map[string]string{
		"a.MP4":          "mp4",
		"archive.tar.gz": "gz",
		"noext":          "",
		".hidden":        "",
		"trailing.":      "",
	}
	for in, want := range cases {
		if got := ExtOf(in); got != want {
			t.Errorf("ExtOf(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestScanMaxNodes(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "a", "f1"), 1)
	writeFile(t, filepath.Join(root, "b", "f2"), 1)
	opts := DefaultOptions()
	opts.MaxNodes = 3
	opts.Workers = 1
	tree, _, err := Scan(context.Background(), root, opts, NewProgress())
	if err != nil {
		t.Fatal(err)
	}
	if !tree.Truncated {
		t.Fatalf("expected truncated tree, len=%d", tree.Len())
	}
	if tree.Len() > 3 {
		t.Fatalf("len=%d exceeds max nodes", tree.Len())
	}
}

func TestMountPointsParse(t *testing.T) {
	m := mountPoints()
	if len(m) == 0 {
		t.Fatal("expected mount points from /proc/self/mounts")
	}
	if !m["/"] {
		t.Fatalf("root mount missing: %v", m)
	}
	if got := unescapeMount(`/mnt/a\040b`); got != "/mnt/a b" {
		t.Fatalf("unescape = %q", got)
	}
}

func TestPathWithRootSlash(t *testing.T) {
	tr := NewTree("/", "/", 0, 100)
	ids := tr.AddChildren(0, []Candidate{
		{Name: "usr", Type: TypeDir},
		{Name: "etc", Type: TypeDir},
	})
	tr.Aggregate()
	if got := tr.Path(ids[0]); got != "/usr" {
		t.Fatalf("path = %q, want /usr", got)
	}
	sub := tr.AddChildren(ids[0], []Candidate{{Name: "bin", Type: TypeDir}})
	tr.Aggregate()
	if got := tr.Path(sub[0]); got != "/usr/bin" {
		t.Fatalf("path = %q, want /usr/bin", got)
	}
}
