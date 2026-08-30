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
    echo "[servermonitor-agent] using configured REPO_URL=$REPO_URL"
    return 0
  fi
  if [[ "$AUTO_GIT_MIRROR" == "0" || "$AUTO_GIT_MIRROR" == "false" ]]; then
    REPO_URL="$DEFAULT_REPO_URL"
    echo "[servermonitor-agent] auto git mirror disabled, using REPO_URL=$REPO_URL"
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
    echo "[servermonitor-agent] testing git mirror: $candidate"
    if ms="$(probe_git_mirror "$candidate")"; then
      echo "[servermonitor-agent] git mirror ok: $candidate (${ms}ms)"
      if (( ms < best_ms )); then
        best="$candidate"
        best_ms="$ms"
      fi
    else
      echo "[servermonitor-agent] git mirror failed/timeout: $candidate"
    fi
  done
  IFS="$old_ifs"

  if [[ -n "$best" ]]; then
    REPO_URL="$best"
  else
    REPO_URL="$DEFAULT_REPO_URL"
    echo "[servermonitor-agent] all git mirror probes failed, fallback REPO_URL=$REPO_URL"
  fi
  echo "[servermonitor-agent] selected REPO_URL=$REPO_URL"
}

clone_repo() {
  local dest="$1" attempt
  select_repo_url
  echo "[servermonitor-agent] cloning $REPO_URL#$BRANCH"
  for attempt in $(seq 1 "$GIT_CLONE_ATTEMPTS"); do
    rm -rf "$dest"
    if command -v timeout >/dev/null 2>&1; then
      timeout "${GIT_CLONE_TIMEOUT}s" git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$dest" && return 0
    else
      git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$dest" && return 0
    fi
    echo "[servermonitor-agent] clone attempt $attempt failed; retrying"
    sleep 2
  done
  echo "[servermonitor-agent] clone failed after $GIT_CLONE_ATTEMPTS attempts" >&2
  return 1
}
INSTALL_DIR="${INSTALL_DIR:-/opt/servermonitor/agent}"
PLIST="${PLIST:-/Library/LaunchDaemons/com.servermonitor.agent.plist}"

plist_env_value() {
  local key="$1"
  [[ -f "$PLIST" ]] || return 0
  awk -v key="$key" '
    $0 ~ "<key>" key "</key>" { getline; gsub(/^[[:space:]]*<string>|<\/string>[[:space:]]*$/, ""); print; exit }
  ' "$PLIST" 2>/dev/null
}

SM_NAME="${SM_NAME:-${1:-}}"
SM_TOKEN="${SM_TOKEN:-${2:-}}"
SM_REPORT_URL="${SM_REPORT_URL:-${3:-}}"
if [[ -z "$SM_REPORT_URL" && "$SM_TOKEN" =~ ^https?:// ]]; then
  SM_REPORT_URL="$SM_TOKEN"
  SM_TOKEN=""
fi

UPDATE_MODE=0
if [[ -f "$PLIST" && -f "$INSTALL_DIR/agent.mjs" ]]; then
  UPDATE_MODE=1
  echo "[servermonitor-agent] existing installation detected: $PLIST"
  [[ -z "$SM_NAME" ]] && SM_NAME="$(plist_env_value SM_NAME)"
  [[ -z "$SM_TOKEN" ]] && SM_TOKEN="$(plist_env_value SM_TOKEN)"
  [[ -z "$SM_REPORT_URL" ]] && SM_REPORT_URL="$(plist_env_value SM_REPORT_URL)"
  SM_INTERVAL="${SM_INTERVAL:-$(plist_env_value SM_INTERVAL)}"
  SM_SLOW_INTERVAL="${SM_SLOW_INTERVAL:-$(plist_env_value SM_SLOW_INTERVAL)}"
  SM_TIMEOUT="${SM_TIMEOUT:-$(plist_env_value SM_TIMEOUT)}"
fi

if [[ -z "$SM_TOKEN" ]]; then
  SM_TOKEN="sm_$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))' 2>/dev/null || openssl rand -hex 16)"
fi
SM_INTERVAL="${SM_INTERVAL:-10}"
SM_SLOW_INTERVAL="${SM_SLOW_INTERVAL:-30}"
SM_TIMEOUT="${SM_TIMEOUT:-5000}"

if [[ -z "$SM_NAME" || -z "$SM_REPORT_URL" ]]; then
  cat <<'EOF'
usage:
  sudo bash install-agent-macos.sh <name> [token] <report-url>
  sudo bash install-agent-macos.sh <name> <report-url>   # 自动生成 token

example:
  sudo bash install-agent-macos.sh mac-01 http://192.168.1.10:2536/servermonitor/report
  sudo bash install-agent-macos.sh mac-01 sm_xxx http://192.168.1.10:2536/servermonitor/report

github mirror env:
  AUTO_GIT_MIRROR=1
  REPO_MIRRORS=https://github.com/...,https://ghfast.top/https://github.com/...
  GIT_MIRROR_PROBE_TIMEOUT=5
  GIT_CLONE_ATTEMPTS=3
EOF
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  echo "please run as root for launchd daemon installation" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 18+ and npm are required" >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
NODE_MAJOR="$($NODE_BIN -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "Node.js 18+ is required, current: $($NODE_BIN -v)" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

clone_repo "$TMP_DIR/servermonitor"

if [[ "$UPDATE_MODE" == "1" ]]; then
  launchctl bootout system "$PLIST" >/dev/null 2>&1 || true
  echo "[servermonitor-agent] updating agent code in $INSTALL_DIR"
fi
mkdir -p "$(dirname "$INSTALL_DIR")"
rm -rf "$INSTALL_DIR"
cp -a "$TMP_DIR/servermonitor/agent" "$INSTALL_DIR"
cd "$INSTALL_DIR"
npm install --omit=dev

mkdir -p /var/log/servermonitor

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.servermonitor.agent</string>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${INSTALL_DIR}/agent.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SM_NAME</key>
    <string>${SM_NAME}</string>
    <key>SM_TOKEN</key>
    <string>${SM_TOKEN}</string>
    <key>SM_REPORT_URL</key>
    <string>${SM_REPORT_URL}</string>
    <key>SM_INTERVAL</key>
    <string>${SM_INTERVAL}</string>
    <key>SM_SLOW_INTERVAL</key>
    <string>${SM_SLOW_INTERVAL}</string>
    <key>SM_TIMEOUT</key>
    <string>${SM_TIMEOUT}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/var/log/servermonitor/agent.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/servermonitor/agent.err.log</string>
</dict>
</plist>
EOF

chown root:wheel "$PLIST"
chmod 644 "$PLIST"
launchctl bootout system "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap system "$PLIST"
launchctl enable system/com.servermonitor.agent
launchctl kickstart -k system/com.servermonitor.agent

echo "[servermonitor-agent] $([[ "$UPDATE_MODE" == "1" ]] && echo updated || echo installed) to $INSTALL_DIR"
echo "[servermonitor-agent] plist: $PLIST"
echo "[servermonitor-agent] logs: tail -f /var/log/servermonitor/agent.log /var/log/servermonitor/agent.err.log"
echo "[servermonitor-agent] token: $SM_TOKEN"
echo "[servermonitor-agent] wait one upload log, then bind in Yunzai private chat: #服务器状态绑定 $SM_TOKEN"
