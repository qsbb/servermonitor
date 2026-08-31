#!/usr/bin/env bash
set -euo pipefail

REPO_URL_INPUT="${REPO_URL:-}"
DEFAULT_REPO_URL="https://github.com/qsbb/servermonitor.git"
REPO_URL="$DEFAULT_REPO_URL"
BRANCH="${BRANCH:-main}"
AUTO_GIT_MIRROR="${AUTO_GIT_MIRROR:-1}"
GIT_MIRROR_PROBE_TIMEOUT="${GIT_MIRROR_PROBE_TIMEOUT:-5}"
INSTALL_DIR="${INSTALL_DIR:-/opt/servermonitor-docker}"
SM_NAME="${SM_NAME:-${1:-}}"
SM_TOKEN="${SM_TOKEN:-${2:-}}"
SM_REPORT_URL="${SM_REPORT_URL:-${3:-}}"
if [[ -z "$SM_REPORT_URL" && "$SM_TOKEN" =~ ^https?:// ]]; then
  SM_REPORT_URL="$SM_TOKEN"
  SM_TOKEN=""
fi

env_value() {
  local key="$1" value
  [[ -f "$INSTALL_DIR/.env" ]] || return 0
  value="$(sed -n "s/^${key}=//p" "$INSTALL_DIR/.env" | tail -n 1)"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

UPDATE_MODE=0
if [[ -f "$INSTALL_DIR/.env" && -f "$INSTALL_DIR/docker-compose.agent.yml" ]]; then
  UPDATE_MODE=1
  echo "[servermonitor-agent] existing docker installation detected: $INSTALL_DIR"
  [[ -z "$SM_NAME" ]] && SM_NAME="$(env_value SM_NAME)"
  [[ -z "$SM_TOKEN" ]] && SM_TOKEN="$(env_value SM_TOKEN)"
  [[ -z "$SM_REPORT_URL" ]] && SM_REPORT_URL="$(env_value SM_REPORT_URL)"
  SM_INTERVAL="${SM_INTERVAL:-$(env_value SM_INTERVAL)}"
  SM_SLOW_INTERVAL="${SM_SLOW_INTERVAL:-$(env_value SM_SLOW_INTERVAL)}"
  SM_TIMEOUT="${SM_TIMEOUT:-$(env_value SM_TIMEOUT)}"
  NODE_IMAGE="${NODE_IMAGE:-$(env_value NODE_IMAGE)}"
fi

if [[ -z "$SM_TOKEN" ]]; then
  SM_TOKEN="sm_$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))' 2>/dev/null || openssl rand -hex 16)"
fi
SM_INTERVAL="${SM_INTERVAL:-10}"
SM_SLOW_INTERVAL="${SM_SLOW_INTERVAL:-30}"
SM_TIMEOUT="${SM_TIMEOUT:-5000}"
GIT_CLONE_ATTEMPTS="${GIT_CLONE_ATTEMPTS:-3}"
GIT_CLONE_TIMEOUT="${GIT_CLONE_TIMEOUT:-300}"
REPO_MIRRORS="${REPO_MIRRORS:-https://github.com/qsbb/servermonitor.git,https://ghfast.top/https://github.com/qsbb/servermonitor.git,https://gh-proxy.com/https://github.com/qsbb/servermonitor.git,https://gitclone.com/github.com/qsbb/servermonitor.git,https://mirror.ghproxy.com/https://github.com/qsbb/servermonitor.git}"

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
AUTO_NODE_IMAGE="${AUTO_NODE_IMAGE:-1}"
NODE_IMAGE_PROBE_TIMEOUT="${NODE_IMAGE_PROBE_TIMEOUT:-8}"
NODE_IMAGE_PRE_PULL="${NODE_IMAGE_PRE_PULL:-1}"
DEFAULT_NODE_IMAGE="node:18-bookworm-slim"
NODE_IMAGE_CANDIDATES="${NODE_IMAGE_CANDIDATES:-node:18-bookworm-slim,docker.1ms.run/library/node:18-bookworm-slim,docker.m.daocloud.io/library/node:18-bookworm-slim,hub.rat.dev/library/node:18-bookworm-slim}"
NODE_IMAGE="${NODE_IMAGE:-}"

now_ms() {
  local ts
  ts="$(date +%s%3N 2>/dev/null || true)"
  if [[ "$ts" =~ ^[0-9]+$ ]]; then
    echo "$ts"
  else
    echo "$(( $(date +%s) * 1000 ))"
  fi
}

probe_node_image() {
  local image="$1"
  local start end
  if docker image inspect "$image" >/dev/null 2>&1; then
    echo 0
    return 0
  fi
  start="$(now_ms)"
  if command -v timeout >/dev/null 2>&1; then
    timeout "${NODE_IMAGE_PROBE_TIMEOUT}s" docker manifest inspect "$image" >/dev/null 2>&1 || return 1
  else
    docker manifest inspect "$image" >/dev/null 2>&1 || return 1
  fi
  end="$(now_ms)"
  echo "$(( end - start ))"
}

select_node_image() {
  if [[ -n "$NODE_IMAGE" ]]; then
    echo "[servermonitor-agent] using configured NODE_IMAGE=$NODE_IMAGE"
    return 0
  fi
  if [[ "$AUTO_NODE_IMAGE" == "0" || "$AUTO_NODE_IMAGE" == "false" ]]; then
    NODE_IMAGE="$DEFAULT_NODE_IMAGE"
    echo "[servermonitor-agent] auto mirror disabled, using NODE_IMAGE=$NODE_IMAGE"
    return 0
  fi

  local old_ifs candidate ms best best_ms
  best=""
  best_ms=999999999
  old_ifs="$IFS"
  IFS=','
  for candidate in $NODE_IMAGE_CANDIDATES; do
    candidate="${candidate//[$'\t\r\n ']/}"
    [[ -z "$candidate" ]] && continue
    echo "[servermonitor-agent] testing node image mirror: $candidate"
    if ms="$(probe_node_image "$candidate")"; then
      echo "[servermonitor-agent] mirror ok: $candidate (${ms}ms)"
      if (( ms < best_ms )); then
        best="$candidate"
        best_ms="$ms"
      fi
    else
      echo "[servermonitor-agent] mirror failed/timeout: $candidate"
    fi
  done
  IFS="$old_ifs"

  if [[ -n "$best" ]]; then
    NODE_IMAGE="$best"
  else
    NODE_IMAGE="$DEFAULT_NODE_IMAGE"
    echo "[servermonitor-agent] all mirror probes failed, fallback NODE_IMAGE=$NODE_IMAGE"
  fi
  echo "[servermonitor-agent] selected NODE_IMAGE=$NODE_IMAGE"
}

if [[ -z "$SM_NAME" || -z "$SM_REPORT_URL" ]]; then
  cat <<'EOF'
usage:
  sudo bash install-agent-docker.sh <name> [token] <report-url>
  sudo bash install-agent-docker.sh <name> <report-url>   # 自动生成 token

example:
  sudo bash install-agent-docker.sh web-01 http://192.168.1.10:2536/servermonitor/report
  sudo bash install-agent-docker.sh web-01 sm_xxx http://192.168.1.10:2536/servermonitor/report

github mirror env:
  AUTO_GIT_MIRROR=1
  REPO_MIRRORS=https://github.com/...,https://ghfast.top/https://github.com/...
  GIT_MIRROR_PROBE_TIMEOUT=5
  GIT_CLONE_ATTEMPTS=3

docker image mirror env:
  AUTO_NODE_IMAGE=1
  NODE_IMAGE=node:18-bookworm-slim
  NODE_IMAGE_CANDIDATES=node:18-bookworm-slim,docker.1ms.run/library/node:18-bookworm-slim
EOF
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin is required" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

clone_repo "$TMP_DIR/servermonitor"

if [[ "$UPDATE_MODE" == "1" ]]; then
  echo "[servermonitor-agent] updating docker deployment in $INSTALL_DIR"
  cp -a "$INSTALL_DIR/.env" "$TMP_DIR/.env.backup"
  rm -rf "$INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  cp -a "$TMP_DIR/servermonitor" "$INSTALL_DIR"
  cp -a "$TMP_DIR/.env.backup" "$INSTALL_DIR/.env"
else
  rm -rf "$INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  cp -a "$TMP_DIR/servermonitor" "$INSTALL_DIR"
fi

select_node_image

cat >"$INSTALL_DIR/.env" <<EOF
SM_NAME=${SM_NAME}
SM_TOKEN=${SM_TOKEN}
SM_REPORT_URL=${SM_REPORT_URL}
SM_INTERVAL=${SM_INTERVAL}
SM_SLOW_INTERVAL=${SM_SLOW_INTERVAL}
SM_TIMEOUT=${SM_TIMEOUT}
NODE_IMAGE=${NODE_IMAGE}
EOF

cd "$INSTALL_DIR"
if [[ "$NODE_IMAGE_PRE_PULL" != "0" && "$NODE_IMAGE_PRE_PULL" != "false" ]]; then
  echo "[servermonitor-agent] pre-pulling selected node image: $NODE_IMAGE"
  docker pull "$NODE_IMAGE" || echo "[servermonitor-agent] pre-pull failed, continue with docker compose build"
fi
docker compose --env-file .env -f docker-compose.agent.yml up -d --build

echo "[servermonitor-agent] docker deployment $([[ "$UPDATE_MODE" == "1" ]] && echo updated || echo installed) to $INSTALL_DIR"
echo "[servermonitor-agent] logs: cd $INSTALL_DIR && docker compose -f docker-compose.agent.yml logs -f"
echo "[servermonitor-agent] token: $SM_TOKEN"
echo "[servermonitor-agent] wait one upload log, then bind in Yunzai private chat: #服务器状态绑定 $SM_TOKEN"
