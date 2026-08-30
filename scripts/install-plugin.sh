#!/usr/bin/env bash
set -euo pipefail

REPO_URL_INPUT="${REPO_URL:-}"
DEFAULT_REPO_URL="https://github.com/qsbb/servermonitor.git"
REPO_URL="$DEFAULT_REPO_URL"
BRANCH="${BRANCH:-main}"
AUTO_GIT_MIRROR="${AUTO_GIT_MIRROR:-1}"
GIT_MIRROR_PROBE_TIMEOUT="${GIT_MIRROR_PROBE_TIMEOUT:-5}"
GIT_CLONE_ATTEMPTS="${GIT_CLONE_ATTEMPTS:-3}"
GIT_CLONE_TIMEOUT="${GIT_CLONE_TIMEOUT:-300}"
REPO_MIRRORS="${REPO_MIRRORS:-https://github.com/qsbb/servermonitor.git,https://ghfast.top/https://github.com/qsbb/servermonitor.git,https://gh-proxy.com/https://github.com/qsbb/servermonitor.git,https://gitclone.com/github.com/qsbb/servermonitor.git,https://mirror.ghproxy.com/https://github.com/qsbb/servermonitor.git}"

now_ms() {
  local ts
  ts="$(date +%s%3N 2>/dev/null || true)"
  if [[ "$ts" =~ ^[0-9]+$ ]]; then
    echo "$ts"
  else
    echo "$(( $(date +%s) * 1000 ))"
  fi
}

probe_git_mirror() {
  local url="$1" start end
  start="$(now_ms)"
  if command -v timeout >/dev/null 2>&1; then
    timeout "${GIT_MIRROR_PROBE_TIMEOUT}s" git ls-remote --heads "$url" "$BRANCH" >/dev/null 2>&1 || return 1
  else
    git ls-remote --heads "$url" "$BRANCH" >/dev/null 2>&1 || return 1
  fi
  end="$(now_ms)"
  echo "$(( end - start ))"
}

select_repo_url() {
  if [[ -n "$REPO_URL_INPUT" ]]; then
    REPO_URL="$REPO_URL_INPUT"
    echo "[servermonitor] using configured REPO_URL=$REPO_URL"
    return 0
  fi
  if [[ "$AUTO_GIT_MIRROR" == "0" || "$AUTO_GIT_MIRROR" == "false" ]]; then
    REPO_URL="$DEFAULT_REPO_URL"
    echo "[servermonitor] auto git mirror disabled, using REPO_URL=$REPO_URL"
    return 0
  fi

  local old_ifs candidate ms best best_ms
  best=""
  best_ms=999999999
  old_ifs="$IFS"
  IFS=','
  for candidate in $REPO_MIRRORS; do
    candidate="${candidate//[$'\t\r\n ']/}"
    [[ -z "$candidate" ]] && continue
    echo "[servermonitor] testing git mirror: $candidate"
    if ms="$(probe_git_mirror "$candidate")"; then
      echo "[servermonitor] git mirror ok: $candidate (${ms}ms)"
      if (( ms < best_ms )); then
        best="$candidate"
        best_ms="$ms"
      fi
    else
      echo "[servermonitor] git mirror failed/timeout: $candidate"
    fi
  done
  IFS="$old_ifs"

  if [[ -n "$best" ]]; then
    REPO_URL="$best"
  else
    REPO_URL="$DEFAULT_REPO_URL"
    echo "[servermonitor] all git mirror probes failed, fallback REPO_URL=$REPO_URL"
  fi
  echo "[servermonitor] selected REPO_URL=$REPO_URL"
}

clone_repo() {
  local dest="$1" attempt
  select_repo_url
  echo "[servermonitor] cloning $REPO_URL#$BRANCH"
  for attempt in $(seq 1 "$GIT_CLONE_ATTEMPTS"); do
    rm -rf "$dest"
    if command -v timeout >/dev/null 2>&1; then
      timeout "${GIT_CLONE_TIMEOUT}s" git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$dest" && return 0
    else
      git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$dest" && return 0
    fi
    echo "[servermonitor] clone attempt $attempt failed; retrying"
    sleep 2
  done
  echo "[servermonitor] clone failed after $GIT_CLONE_ATTEMPTS attempts" >&2
  return 1
}
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

clone_repo "$TMP_DIR/servermonitor"

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
