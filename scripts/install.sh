#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install.mjs -o "$TMP_DIR/install.mjs"
node "$TMP_DIR/install.mjs" "$@"
