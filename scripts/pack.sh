#!/usr/bin/env bash
# Build and package the fnOS .fpk artifact.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bash scripts/build.sh

VER="$(grep -E '^version[[:space:]]*=' packaging/manifest | head -n1 | awk -F= '{gsub(/[[:space:]]/,"",$2); print $2}')"
VER="${VER:-1.0.0}"

# fnpack is sensitive to permission bits; normalize before packing.
find packaging -type d -exec chmod 0755 {} +
find packaging -type f -exec chmod 0644 {} +
chmod 0755 packaging/cmd/* packaging/app/server/trtree-linux-*

# 优先用官方 fnpack；没有就退回纯 Python 打包器（scripts/fpk.py），
# 两者产物结构、权限、manifest checksum 等价，Python 版已在真机验证可安装。
FNpack="${FNpack:-$ROOT/.tools/fnpack}"
if [ -x "$FNpack" ]; then
  echo "==> fnpack build"
  # Remove stale artifacts first so pack.sh can never re-package an old fpk.
  rm -f "$ROOT/packaging/trtree.fpk" "$ROOT/packaging/trtree-${VER}.fpk"
  (cd packaging && "$FNpack" build --directory "$ROOT/packaging")

  # fnpack writes trtree.fpk into the working directory (packaging/).
  FPK="$ROOT/packaging/trtree.fpk"
  if [ ! -f "$FPK" ]; then
    FPK="$(find "$ROOT/packaging" -maxdepth 1 -name '*.fpk' -newermt '-2 minutes' 2>/dev/null | head -n1)"
  fi
  if [ -z "$FPK" ] || [ ! -f "$FPK" ]; then
    echo "ERROR: fpk not found after fnpack build" >&2
    exit 1
  fi

  mkdir -p dist
  rm -f "dist/trtree-${VER}.fpk"
  cp -f "$FPK" "dist/trtree-${VER}.fpk"
  chmod 0644 "dist/trtree-${VER}.fpk"
  # fnpack writes its intermediate artifact into packaging/; keep the tree clean.
  rm -f "$ROOT/packaging/trtree.fpk" "$ROOT/packaging/trtree-${VER}.fpk"
else
  if command -v fnpack >/dev/null 2>&1; then
    FNpack="$(command -v fnpack)"
    exec env FNpack="$FNpack" bash "$0" "${@:-}"
  fi
  echo "==> fnpack not found, using scripts/fpk.py"
  python3 "$ROOT/scripts/fpk.py" --root "$ROOT" --out "$ROOT/dist/trtree-${VER}.fpk"
fi

# Guard: the freshly built fpk must carry the manifest version we just read.
if ! tar xzOf "$ROOT/dist/trtree-${VER}.fpk" manifest 2>/dev/null | grep -Eq "^version[[:space:]]*=[[:space:]]*${VER}[[:space:]]*$"; then
  echo "ERROR: packaged manifest version mismatch (expected ${VER})" >&2
  exit 1
fi

echo "==> packaged: dist/trtree-${VER}.fpk"
ls -lh "dist/trtree-${VER}.fpk"
