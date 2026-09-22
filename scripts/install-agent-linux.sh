#!/usr/bin/env bash
set -euo pipefail

REPO_URL_INPUT="${REPO_URL:-}"
DEFAULT_REPO_URL="https://github.com/qsbb/servermonitor.git"
REPO_URL="$DEFAULT_REPO_URL"
BRANCH="${BRANCH:-main}"
AUTO_GIT_MIRROR="${AUTO_GIT_MIRROR:-1}"
GIT_MIRROR_PROBE_TIMEOUT="${GIT_MIRROR_PROBE_TIMEOUT:-5}"
GIT_VERIFY_TIMEOUT="${GIT_VERIFY_TIMEOUT:-15}"
GIT_CLONE_ATTEMPTS="${GIT_CLONE_ATTEMPTS:-3}"
GIT_CLONE_TIMEOUT="${GIT_CLONE_TIMEOUT:-300}"
REPO_MIRRORS="${REPO_MIRRORS:-https://github.com/qsbb/servermonitor.git,https://ghfast.top/https://github.com/qsbb/servermonitor.git,https://gh-proxy.com/https://github.com/qsbb/servermonitor.git,https://gitclone.com/github.com/qsbb/servermonitor.git,https://mirror.ghproxy.com/https://github.com/qsbb/servermonitor.git}"
AUTO_SELECTED_MIRROR=0

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

  # 官方源可达时始终优先官方：第三方镜像可能滞后，导致“更新”实际安装旧版本
  if probe_git_mirror "$DEFAULT_REPO_URL" >/dev/null 2>&1; then
    REPO_URL="$DEFAULT_REPO_URL"
    echo "[servermonitor-agent] official repo reachable, using $REPO_URL"
    return 0
  fi
  echo "[servermonitor-agent] warning: official repo unreachable, falling back to third-party mirrors (content may lag)"

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
    AUTO_SELECTED_MIRROR=1
  else
    REPO_URL="$DEFAULT_REPO_URL"
    echo "[servermonitor-agent] all git mirror probes failed, fallback REPO_URL=$REPO_URL"
  fi
  echo "[servermonitor-agent] selected REPO_URL=$REPO_URL"
}

verify_clone_matches_official() {
  local dest="$1" cloned official
  [[ "${AUTO_SELECTED_MIRROR:-0}" == "1" ]] || return 0
  cloned="$(git -C "$dest" rev-parse HEAD 2>/dev/null || true)"
  if command -v timeout >/dev/null 2>&1; then
    official="$(timeout "${GIT_VERIFY_TIMEOUT}s" git ls-remote "$DEFAULT_REPO_URL" "refs/heads/$BRANCH" 2>/dev/null | awk 'NR==1{print $1}')"
  else
    official="$(git ls-remote "$DEFAULT_REPO_URL" "refs/heads/$BRANCH" 2>/dev/null | awk 'NR==1{print $1}')"
  fi
  if [[ -z "$official" ]]; then
    if [[ "${ALLOW_UNVERIFIED_MIRROR:-0}" == "1" || "${ALLOW_UNVERIFIED_MIRROR:-0}" == "true" ]]; then
      echo "[servermonitor-agent] warning: cannot verify mirror freshness against official repo; continuing because ALLOW_UNVERIFIED_MIRROR=1" >&2
      return 0
    fi
    echo "[servermonitor-agent] error: cannot verify that the auto-selected mirror is up to date" >&2
    echo "[servermonitor-agent]   mirror HEAD:   ${cloned:-unknown}" >&2
    echo "[servermonitor-agent]   official repo is unreachable from this machine" >&2
    echo "[servermonitor-agent] set ALLOW_UNVERIFIED_MIRROR=1 to accept the risk (may install an older version)" >&2
    echo "[servermonitor-agent] or set REPO_URL=$DEFAULT_REPO_URL / AUTO_GIT_MIRROR=0 with a working proxy" >&2
    return 1
  fi
  if [[ -n "$cloned" && "$cloned" != "$official" ]]; then
    echo "[servermonitor-agent] error: selected mirror is stale" >&2
    echo "[servermonitor-agent]   mirror HEAD:   $cloned" >&2
    echo "[servermonitor-agent]   official HEAD: $official" >&2
    echo "[servermonitor-agent] set AUTO_GIT_MIRROR=0 or REPO_URL=$DEFAULT_REPO_URL to update from the official repo" >&2
    return 1
  fi
  return 0
}

clone_repo() {
  local dest="$1" attempt
  select_repo_url
  echo "[servermonitor-agent] cloning $REPO_URL#$BRANCH"
  for attempt in $(seq 1 "$GIT_CLONE_ATTEMPTS"); do
    rm -rf "$dest"
    if command -v timeout >/dev/null 2>&1; then
      if timeout "${GIT_CLONE_TIMEOUT}s" git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$dest"; then
        verify_clone_matches_official "$dest" && return 0
        return 1
      fi
    else
      if git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$dest"; then
        verify_clone_matches_official "$dest" && return 0
        return 1
      fi
    fi
    echo "[servermonitor-agent] clone attempt $attempt failed; retrying"
    sleep 2
  done
  echo "[servermonitor-agent] clone failed after $GIT_CLONE_ATTEMPTS attempts" >&2
  return 1
}
INSTALL_DIR="${INSTALL_DIR:-/opt/servermonitor/agent}"
SERVICE_NAME="${SERVICE_NAME:-servermonitor-agent}"
SERVICE_DIR="${SERVICE_DIR:-/etc/systemd/system}"
SERVICE_FILE="${SERVICE_DIR}/${SERVICE_NAME}.service"
SKIP_ROOT_CHECK="${SKIP_ROOT_CHECK:-0}"
HEALTH_CHECK_DELAY="${HEALTH_CHECK_DELAY:-2}"

validate_install_dir() {
  local dir="$1"
  [[ "$dir" == /* ]] || { echo "INSTALL_DIR must be an absolute path" >&2; exit 1; }
  [[ "$dir" != "/" ]] || { echo "INSTALL_DIR must not be /" >&2; exit 1; }
  [[ "$dir" == *servermonitor* ]] || { echo "INSTALL_DIR must contain 'servermonitor'" >&2; exit 1; }
}

config_value() {
  local key="$1"
  [[ -f "$INSTALL_DIR/servermonitor-agent.json" ]] || return 0
  node -e 'const fs=require("fs");try{const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const v=c[process.argv[2]];if(v!==undefined&&v!==null)process.stdout.write(String(v))}catch{}' \
    "$INSTALL_DIR/servermonitor-agent.json" "$key" 2>/dev/null || true
}

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
  [[ -z "$SM_NAME" ]] && SM_NAME="$(config_value name)"
  [[ -z "$SM_TOKEN" ]] && SM_TOKEN="$(config_value token)"
  [[ -z "$SM_REPORT_URL" ]] && SM_REPORT_URL="$(config_value reportUrl)"
  SM_INTERVAL="${SM_INTERVAL:-$(config_value interval)}"
  SM_SLOW_INTERVAL="${SM_SLOW_INTERVAL:-$(config_value slowInterval)}"
  SM_TIMEOUT="${SM_TIMEOUT:-$(config_value timeout)}"
  # migrate from unit environment lines written by older versions
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
  # allow installing from a mirror when the official repo is unreachable (may be stale)
  ALLOW_UNVERIFIED_MIRROR=1
EOF
  exit 1
fi

validate_install_dir "$INSTALL_DIR"

if [[ "$SKIP_ROOT_CHECK" != "1" && $EUID -ne 0 ]]; then
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
STAGING="${INSTALL_DIR}.new-$$"
BACKUP="${INSTALL_DIR}.bak-$$"
UNIT_BACKUP="${SERVICE_FILE}.bak-$$"
STAGING_UNIT="${TMP_DIR}/${SERVICE_NAME}.service"

cleanup() {
  rm -rf "${TMP_DIR:-}" "${STAGING:-}" "${STAGING_UNIT:-}"
}
trap cleanup EXIT

clone_repo "$TMP_DIR/servermonitor"

mkdir -p "$STAGING"
cp -a "$TMP_DIR/servermonitor/agent/." "$STAGING/"
cd "$STAGING"
npm install --omit=dev
node --check agent.mjs
node -e 'import("systeminformation").then(()=>{}, e => { console.error(e.message); process.exit(1) })'
node -e 'const fs=require("fs");const [file,name,token,url,interval,slow,timeout]=process.argv.slice(1);fs.writeFileSync(file,JSON.stringify({name,token,reportUrl:url,interval:Number(interval),slowInterval:Number(slow),timeout:Number(timeout)},null,2),{mode:0o600})' \
  "$STAGING/servermonitor-agent.json" "$SM_NAME" "$SM_TOKEN" "$SM_REPORT_URL" "$SM_INTERVAL" "$SM_SLOW_INTERVAL" "$SM_TIMEOUT"
chmod 600 "$STAGING/servermonitor-agent.json"

cat >"$STAGING_UNIT" <<EOF
[Unit]
Description=servermonitor agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/agent.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

rollback() {
  echo "[servermonitor-agent] update failed, restoring previous installation" >&2
  rm -rf "$INSTALL_DIR"
  if [[ -d "$BACKUP" ]]; then mv "$BACKUP" "$INSTALL_DIR"; fi
  if [[ -f "$UNIT_BACKUP" ]]; then mv "$UNIT_BACKUP" "$SERVICE_FILE"; fi
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  exit 1
}

if [[ "$UPDATE_MODE" == "1" ]]; then
  echo "[servermonitor-agent] updating agent code in $INSTALL_DIR"
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
fi

mkdir -p "$(dirname "$INSTALL_DIR")"
if [[ -d "$INSTALL_DIR" ]]; then mv "$INSTALL_DIR" "$BACKUP"; fi
mv "$STAGING" "$INSTALL_DIR"
if [[ -f "$SERVICE_FILE" ]]; then cp -a "$SERVICE_FILE" "$UNIT_BACKUP"; fi
cp "$STAGING_UNIT" "$SERVICE_FILE"
chmod 644 "$SERVICE_FILE"

systemctl daemon-reload || rollback
systemctl enable --now "$SERVICE_NAME" || rollback
sleep "$HEALTH_CHECK_DELAY"
systemctl is-active --quiet "$SERVICE_NAME" || rollback

rm -rf "$BACKUP" "$UNIT_BACKUP"

echo "[servermonitor-agent] $([[ "$UPDATE_MODE" == "1" ]] && echo updated || echo installed) to $INSTALL_DIR"
echo "[servermonitor-agent] service: $SERVICE_NAME"
echo "[servermonitor-agent] status: systemctl status $SERVICE_NAME"
echo "[servermonitor-agent] logs: journalctl -u $SERVICE_NAME -f"
echo "[servermonitor-agent] config: $INSTALL_DIR/servermonitor-agent.json (mode 600)"
echo "[servermonitor-agent] token: $SM_TOKEN"
echo "[servermonitor-agent] wait one upload log, then bind in Yunzai private chat: #服务器状态绑定 $SM_TOKEN"
