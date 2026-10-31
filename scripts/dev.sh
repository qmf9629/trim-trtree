#!/usr/bin/env bash
# Local development server (live web dir, no fnOS required).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
GO="${GO:-$ROOT/.tools/go/bin/go}"
[ -x "$GO" ] || GO=go

mkdir -p dist .devdata
CGO_ENABLED=0 "$GO" build -trimpath -o dist/trtree-dev .
echo "==> http://127.0.0.1:${PORT:-18080}/"
exec env \
  PORT="${PORT:-18080}" \
  TRTREE_DATA_DIR="$ROOT/.devdata" \
  TRTREE_WEB_DIR="$ROOT/src/web" \
  TRTREE_ALLOW_ALL=1 \
  dist/trtree-dev
