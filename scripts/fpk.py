#!/usr/bin/env python3
"""Build a fnOS .fpk without the external fnpack binary.

An .fpk is a gzipped tar with this layout:

    manifest            # key = value lines, parsed by the app center
    ICON.PNG
    ICON_256.PNG
    cmd/                # lifecycle scripts (0755)
    config/
        privilege
        resource
    wizard/             # optional, may be empty
    app.tgz             # gzipped tar with the actual payload

`app.tgz` contains:

    server/             # the binaries
    ui/                 # desktop entry + icons
    config/

This mirrors what `fnpack build --directory packaging` produces, so the
result installs identically. Keeping it in-tree lets CI build releases
without downloading a vendor tool.

Usage: python3 scripts/fpk.py [--root DIR] [--out FILE]
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import os
import re
import sys
import tarfile
from pathlib import Path

# 与 fnpack 保持一致：全局 mtime 归零，产物可复现
FIXED_MTIME = 0

# 顶层要打进去的条目（顺序固定，install 时行为可预期）
TOP_LEVEL_EXEC = ("cmd/",)
TOP_FILES = ("manifest", "ICON.PNG", "ICON_256.PNG")
TOP_DIRS = ("cmd", "config", "wizard")

# app.tgz 的内容
APP_DIRS = ("server", "ui", "config")


def read_version(root: Path) -> str:
    text = (root / "packaging" / "manifest").read_text(encoding="utf-8")
    m = re.search(r"^version\s*=\s*(\S+)\s*$", text, re.M)
    if not m:
        raise SystemExit("ERROR: cannot read version from packaging/manifest")
    return m.group(1)


def add_file(tar: tarfile.TarFile, src: Path, arcname: str, mode: int) -> None:
    """Add a single regular file with a fixed mtime so builds are reproducible."""
    data = src.read_bytes()
    info = tarfile.TarInfo(arcname)
    info.size = len(data)
    info.mtime = FIXED_MTIME
    info.mode = mode
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    tar.addfile(info, io.BytesIO(data))


def add_dir(tar: tarfile.TarFile, arcname: str, mode: int = 0o755) -> None:
    info = tarfile.TarInfo(arcname.rstrip("/") + "/")
    info.type = tarfile.DIRTYPE
    info.mtime = FIXED_MTIME
    info.mode = mode
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    tar.addfile(info)


def mode_for(rel: str) -> int:
    """Lifecycle scripts and the bundled binaries must be executable."""
    if rel.startswith("cmd/") or rel.startswith("server/"):
        return 0o755
    return 0o644


def walk_into(tar: tarfile.TarFile, base: Path, prefix: str, skip: set[str]) -> None:
    entries = sorted(base.iterdir(), key=lambda p: p.name)
    for p in entries:
        rel = f"{prefix}{p.name}"
        if rel in skip:
            continue
        if p.is_dir():
            add_dir(tar, rel)
            walk_into(tar, p, rel + "/", skip)
        elif p.is_file():
            add_file(tar, p, rel, mode_for(rel))
        else:
            print(f"WARN: skipping non-regular file {p}", file=sys.stderr)


def build_app_tgz(packaging: Path) -> bytes:
    """Build the inner app.tgz payload.

    fnpack ships the top-level `config/` inside the payload as well as at the
    fpk root, so mirror that here.
    """
    app_root = packaging / "app"
    if not app_root.is_dir():
        raise SystemExit(f"ERROR: {app_root} not found")

    buf = io.BytesIO()
    # mtime=0 → reproducible; gzip 头部也不要写时间戳
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.GNU_FORMAT) as tar:
        if not (app_root / "server").is_dir():
            raise SystemExit("ERROR: packaging/app/server missing (run scripts/build.sh first)")
        for d in APP_DIRS:
            src = app_root / d
            if src.is_dir():
                add_dir(tar, d)
                walk_into(tar, src, d + "/", set())
            elif d == "config" and (packaging / "config").is_dir():
                # config/ 不在 app/ 下，但 payload 里需要一份
                add_dir(tar, d)
                walk_into(tar, packaging / "config", d + "/", set())
    return gzip_bytes(buf.getvalue())


def gzip_bytes(data: bytes) -> bytes:
    """gzip with mtime=0 so the same input always yields the same bytes."""
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb", mtime=FIXED_MTIME, compresslevel=9) as gz:
        gz.write(data)
    return out.getvalue()


def manifest_bytes(packaging: Path, app_tgz: bytes) -> bytes:
    """manifest 原文 + fnpack 风格的 payload 校验行（md5(app.tgz)）。"""
    text = (packaging / "manifest").read_text(encoding="utf-8")
    # 源文件里若残留 checksum 行（例如手工从 fpk 里解出来的），先剔除
    lines = [ln for ln in text.splitlines() if not ln.strip().startswith("checksum")]
    lines.append(f"checksum                   = {hashlib.md5(app_tgz).hexdigest()}")
    return ("\n".join(lines) + "\n").encode("utf-8")


def build_fpk(root: Path) -> tuple[bytes, str]:
    packaging = root / "packaging"
    version = read_version(root)

    app_tgz = build_app_tgz(packaging)
    manifest = manifest_bytes(packaging, app_tgz)

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.GNU_FORMAT) as tar:
        # app.tgz 放在最前面，与 fnpack 的顺序一致
        info = tarfile.TarInfo("app.tgz")
        info.size = len(app_tgz)
        info.mtime = FIXED_MTIME
        info.mode = 0o644
        info.uid = 0
        info.gid = 0
        info.uname = "root"
        info.gname = "root"
        tar.addfile(info, io.BytesIO(app_tgz))

        for name in TOP_FILES:
            if name == "manifest":
                # 用带 checksum 的版本，而不是源文件
                info = tarfile.TarInfo(name)
                info.size = len(manifest)
                info.mtime = FIXED_MTIME
                info.mode = 0o644
                info.uid = 0
                info.gid = 0
                info.uname = "root"
                info.gname = "root"
                tar.addfile(info, io.BytesIO(manifest))
                continue
            p = packaging / name
            if not p.is_file():
                raise SystemExit(f"ERROR: {p} not found")
            add_file(tar, p, name, 0o644)

        for d in TOP_DIRS:
            dp = packaging / d
            if not dp.is_dir():
                if d == "wizard":
                    add_dir(tar, d)
                    continue
                raise SystemExit(f"ERROR: {dp} not found")
            add_dir(tar, d)
            if d in TOP_DIRS:
                walk_into(tar, dp, d + "/", set())

    return gzip_bytes(buf.getvalue()), version


def main() -> int:
    ap = argparse.ArgumentParser(description="Build a fnOS .fpk")
    ap.add_argument("--root", default=None, help="project root (default: repo root)")
    ap.add_argument("--out", default=None, help="output file (default: dist/trtree-<ver>.fpk)")
    args = ap.parse_args()

    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parent.parent
    blob, version = build_fpk(root)

    out = Path(args.out) if args.out else root / "dist" / f"trtree-{version}.fpk"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(blob)
    os.chmod(out, 0o644)

    print(f"==> built {out} ({len(blob) / 1024 / 1024:.1f} MiB, version {version})")
    return 0


if __name__ == "__main__":
    sys.exit(main())