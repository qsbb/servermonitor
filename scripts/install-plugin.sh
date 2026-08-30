#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/qsbb/servermonitor.git}"
BRANCH="${BRANCH:-main}"
YUNZAI_DIR="${1:-${YUNZAI_DIR:-}}"

if [[ -z "$YUNZAI_DIR" ]]; then
  cat <<'EOF'
usage:
  bash install-plugin.sh /path/to/Yunzai

or:
  YUNZAI_DIR=/path/to/Yunzai bash install-plugin.sh
EOF
  exit 1
fi

if [[ ! -d "$YUNZAI_DIR" ]]; then
  echo "Yunzai directory not found: $YUNZAI_DIR" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi

PLUGIN_DIR="$YUNZAI_DIR/plugins/servermonitor"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "[servermonitor] cloning $REPO_URL#$BRANCH"
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$TMP_DIR/servermonitor"

mkdir -p "$YUNZAI_DIR/plugins"

if [[ -f "$PLUGIN_DIR/config.yaml" ]]; then
  cp "$PLUGIN_DIR/config.yaml" "$TMP_DIR/config.yaml"
fi
if [[ -d "$PLUGIN_DIR/data" ]]; then
  cp -a "$PLUGIN_DIR/data" "$TMP_DIR/data"
fi

rm -rf "$PLUGIN_DIR"
cp -a "$TMP_DIR/servermonitor" "$PLUGIN_DIR"

if [[ -f "$TMP_DIR/config.yaml" ]]; then
  cp "$TMP_DIR/config.yaml" "$PLUGIN_DIR/config.yaml"
fi
if [[ -d "$TMP_DIR/data" ]]; then
  rm -rf "$PLUGIN_DIR/data"
  cp -a "$TMP_DIR/data" "$PLUGIN_DIR/data"
fi
mkdir -p "$PLUGIN_DIR/data"

if [[ ! -f "$PLUGIN_DIR/index.js" ]]; then
  echo "install failed: $PLUGIN_DIR/index.js missing" >&2
  exit 1
fi

echo "[servermonitor] installed to $PLUGIN_DIR"
echo "[servermonitor] restart TRSS-Yunzai, then send: #服务器状态检查"
