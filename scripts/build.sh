#!/usr/bin/env bash
# Build TrTree for both fnOS architectures and stage the fnpack payload.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

GO="${GO:-$ROOT/.tools/go/bin/go}"
if [ ! -x "$GO" ]; then
  if command -v go >/dev/null 2>&1; then
    GO=go
  else
    echo "ERROR: Go toolchain not found (expected $ROOT/.tools/go/bin/go)" >&2
    exit 1
  fi
fi

VER="$(grep -E '^version[[:space:]]*=' packaging/manifest | head -n1 | awk -F= '{gsub(/[[:space:]]/,"",$2); print $2}')"
VER="${VER:-1.0.0}"
BUILD="$(date +%Y%m%d%H%M)"

echo "==> TrTree ${VER} (${BUILD})"
mkdir -p dist packaging/app/server

echo "==> generating icons"
python3 scripts/gen_icons.py >/dev/null

echo "==> building linux/amd64"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 "$GO" build -trimpath \
  -ldflags "-s -w -X trtree/internal/version.Version=${VER} -X trtree/internal/version.Build=${BUILD}" \
  -o packaging/app/server/trtree-linux-amd64 .

echo "==> building linux/arm64"
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 "$GO" build -trimpath \
  -ldflags "-s -w -X trtree/internal/version.Version=${VER} -X trtree/internal/version.Build=${BUILD}" \
  -o packaging/app/server/trtree-linux-arm64 .

chmod 0755 packaging/app/server/trtree-linux-*
echo "==> artifacts"
ls -lh packaging/app/server/
