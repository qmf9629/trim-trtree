#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
GO="${GO:-$ROOT/.tools/go/bin/go}"
[ -x "$GO" ] || GO=go
"$GO" vet ./...
"$GO" test ./... -count=1
