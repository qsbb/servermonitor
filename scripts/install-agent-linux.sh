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
SERVICE_NAME="${SERVICE_NAME:-servermonitor-agent}"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

svc_env_value() {
  local key="$1"
  [[ -f "$SERVICE_FILE" ]] || return 0
  sed -n -e "s/^Environment=\"${key}=\(.*\)\"$/\1/p" -e "s/^Environment=${key}=\(.*\)$/\1/p" "$SERVICE_FILE" | tail -n 1
}

SM_NAME="${SM_NAME:-${1:-}}"
SM_TOKEN="${SM_TOKEN:-${2:-}}"
SM_REPORT_URL="${SM_REPORT_URL:-${3:-}}"
if [[ -z "$SM_REPORT_URL" && "$SM_TOKEN" =~ ^https?:// ]]; then
  SM_REPORT_URL="$SM_TOKEN"
  SM_TOKEN=""
fi

UPDATE_MODE=0
if [[ -f "$SERVICE_FILE" && -f "$INSTALL_DIR/agent.mjs" ]]; then
  UPDATE_MODE=1
  echo "[servermonitor-agent] existing installation detected: $SERVICE_FILE"
  [[ -z "$SM_NAME" ]] && SM_NAME="$(svc_env_value SM_NAME)"
  [[ -z "$SM_TOKEN" ]] && SM_TOKEN="$(svc_env_value SM_TOKEN)"
  [[ -z "$SM_REPORT_URL" ]] && SM_REPORT_URL="$(svc_env_value SM_REPORT_URL)"
  SM_INTERVAL="${SM_INTERVAL:-$(svc_env_value SM_INTERVAL)}"
  SM_SLOW_INTERVAL="${SM_SLOW_INTERVAL:-$(svc_env_value SM_SLOW_INTERVAL)}"
  SM_TIMEOUT="${SM_TIMEOUT:-$(svc_env_value SM_TIMEOUT)}"
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
  sudo bash install-agent-linux.sh <name> [token] <report-url>
  sudo bash install-agent-linux.sh <name> <report-url>   # 自动生成 token

example:
  sudo bash install-agent-linux.sh web-01 http://192.168.1.10:2536/servermonitor/report
  sudo bash install-agent-linux.sh web-01 sm_xxx http://192.168.1.10:2536/servermonitor/report

env overrides:
  INSTALL_DIR=/opt/servermonitor/agent
  SM_INTERVAL=10
  SM_SLOW_INTERVAL=30

github mirror env:
  AUTO_GIT_MIRROR=1
  REPO_MIRRORS=https://github.com/...,https://ghfast.top/https://github.com/...
  GIT_MIRROR_PROBE_TIMEOUT=5
  GIT_CLONE_ATTEMPTS=3
EOF
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  echo "please run as root for systemd installation" >&2
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
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  echo "[servermonitor-agent] updating agent code in $INSTALL_DIR"
fi
mkdir -p "$(dirname "$INSTALL_DIR")"
rm -rf "$INSTALL_DIR"
cp -a "$TMP_DIR/servermonitor/agent" "$INSTALL_DIR"

cd "$INSTALL_DIR"
npm install --omit=dev

cat >"/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=servermonitor agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
Environment="SM_NAME=${SM_NAME}"
Environment="SM_TOKEN=${SM_TOKEN}"
Environment="SM_REPORT_URL=${SM_REPORT_URL}"
Environment="SM_INTERVAL=${SM_INTERVAL}"
Environment="SM_SLOW_INTERVAL=${SM_SLOW_INTERVAL}"
Environment="SM_TIMEOUT=${SM_TIMEOUT}"
ExecStart=${NODE_BIN} ${INSTALL_DIR}/agent.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

echo "[servermonitor-agent] $([[ "$UPDATE_MODE" == "1" ]] && echo updated || echo installed) to $INSTALL_DIR"
echo "[servermonitor-agent] service: $SERVICE_NAME"
echo "[servermonitor-agent] status: systemctl status $SERVICE_NAME"
echo "[servermonitor-agent] logs: journalctl -u $SERVICE_NAME -f"
echo "[servermonitor-agent] token: $SM_TOKEN"
echo "[servermonitor-agent] wait one upload log, then bind in Yunzai private chat: #服务器状态绑定 $SM_TOKEN"
