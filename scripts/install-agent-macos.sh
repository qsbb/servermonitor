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
LAUNCHD_DIR="${LAUNCHD_DIR:-/Library/LaunchDaemons}"
PLIST="${PLIST:-${LAUNCHD_DIR}/com.servermonitor.agent.plist}"
LABEL="com.servermonitor.agent"
LOG_DIR="${LOG_DIR:-/var/log/servermonitor}"
SKIP_ROOT_CHECK="${SKIP_ROOT_CHECK:-0}"
HEALTH_CHECK_DELAY="${HEALTH_CHECK_DELAY:-2}"

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  printf '%s' "$value"
}

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
  [[ -z "$SM_NAME" ]] && SM_NAME="$(config_value name)"
  [[ -z "$SM_TOKEN" ]] && SM_TOKEN="$(config_value token)"
  [[ -z "$SM_REPORT_URL" ]] && SM_REPORT_URL="$(config_value reportUrl)"
  SM_INTERVAL="${SM_INTERVAL:-$(config_value interval)}"
  SM_SLOW_INTERVAL="${SM_SLOW_INTERVAL:-$(config_value slowInterval)}"
  SM_TIMEOUT="${SM_TIMEOUT:-$(config_value timeout)}"
  # migrate from plist environment values written by older versions
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
  # allow installing from a mirror when the official repo is unreachable (may be stale)
  ALLOW_UNVERIFIED_MIRROR=1
EOF
  exit 1
fi

validate_install_dir "$INSTALL_DIR"

if [[ "$SKIP_ROOT_CHECK" != "1" && $EUID -ne 0 ]]; then
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
STAGING="${INSTALL_DIR}.new-$$"
BACKUP="${INSTALL_DIR}.bak-$$"
PLIST_BACKUP="${PLIST}.bak-$$"
STAGING_PLIST="${TMP_DIR}/com.servermonitor.agent.plist"

cleanup() {
  rm -rf "${TMP_DIR:-}" "${STAGING:-}" "${STAGING_PLIST:-}"
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

mkdir -p "$(dirname "$PLIST")"
cat >"$STAGING_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$INSTALL_DIR")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE_BIN")</string>
    <string>$(xml_escape "${INSTALL_DIR}/agent.mjs")</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "${LOG_DIR}/agent.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "${LOG_DIR}/agent.err.log")</string>
</dict>
</plist>
EOF

rollback() {
  echo "[servermonitor-agent] update failed, restoring previous installation" >&2
  rm -rf "$INSTALL_DIR"
  if [[ -d "$BACKUP" ]]; then mv "$BACKUP" "$INSTALL_DIR"; fi
  if [[ -f "$PLIST_BACKUP" ]]; then mv "$PLIST_BACKUP" "$PLIST"; fi
  launchctl bootout system "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap system "$PLIST" >/dev/null 2>&1 || true
  launchctl enable "system/${LABEL}" >/dev/null 2>&1 || true
  launchctl kickstart -k "system/${LABEL}" >/dev/null 2>&1 || true
  exit 1
}

mkdir -p "$LOG_DIR"

if [[ "$UPDATE_MODE" == "1" ]]; then
  echo "[servermonitor-agent] updating agent code in $INSTALL_DIR"
  launchctl bootout system "$PLIST" >/dev/null 2>&1 || true
fi

mkdir -p "$(dirname "$INSTALL_DIR")"
if [[ -d "$INSTALL_DIR" ]]; then mv "$INSTALL_DIR" "$BACKUP"; fi
mv "$STAGING" "$INSTALL_DIR"
if [[ -f "$PLIST" ]]; then cp -a "$PLIST" "$PLIST_BACKUP"; fi
cp "$STAGING_PLIST" "$PLIST"
chown root:wheel "$PLIST" 2>/dev/null || true
chmod 644 "$PLIST"

launchctl bootstrap system "$PLIST" || rollback
launchctl enable "system/${LABEL}" || rollback
launchctl kickstart -k "system/${LABEL}" || rollback
sleep "$HEALTH_CHECK_DELAY"
launchctl print "system/${LABEL}" >/dev/null 2>&1 || rollback

rm -rf "$BACKUP" "$PLIST_BACKUP"

echo "[servermonitor-agent] $([[ "$UPDATE_MODE" == "1" ]] && echo updated || echo installed) to $INSTALL_DIR"
echo "[servermonitor-agent] plist: $PLIST"
echo "[servermonitor-agent] logs: tail -f $LOG_DIR/agent.log $LOG_DIR/agent.err.log"
echo "[servermonitor-agent] config: $INSTALL_DIR/servermonitor-agent.json (mode 600)"
echo "[servermonitor-agent] token: $SM_TOKEN"
echo "[servermonitor-agent] wait one upload log, then bind in Yunzai private chat: #服务器状态绑定 $SM_TOKEN"
