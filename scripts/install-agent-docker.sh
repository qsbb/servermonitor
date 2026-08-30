#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/qsbb/servermonitor.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/servermonitor-docker}"
SM_NAME="${SM_NAME:-${1:-}}"
SM_TOKEN="${SM_TOKEN:-${2:-}}"
SM_REPORT_URL="${SM_REPORT_URL:-${3:-}}"
SM_INTERVAL="${SM_INTERVAL:-10}"
SM_SLOW_INTERVAL="${SM_SLOW_INTERVAL:-30}"
SM_TIMEOUT="${SM_TIMEOUT:-5000}"

if [[ -z "$SM_NAME" || -z "$SM_TOKEN" || -z "$SM_REPORT_URL" ]]; then
  cat <<'EOF'
usage:
  sudo bash install-agent-docker.sh <name> <token> <report-url>

example:
  sudo bash install-agent-docker.sh web-01 sm_xxx http://192.168.1.10:2536/servermonitor/report
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

echo "[servermonitor-agent] cloning $REPO_URL#$BRANCH"
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$TMP_DIR/servermonitor"

rm -rf "$INSTALL_DIR"
mkdir -p "$(dirname "$INSTALL_DIR")"
cp -a "$TMP_DIR/servermonitor" "$INSTALL_DIR"

cat >"$INSTALL_DIR/.env" <<EOF
SM_NAME=${SM_NAME}
SM_TOKEN=${SM_TOKEN}
SM_REPORT_URL=${SM_REPORT_URL}
SM_INTERVAL=${SM_INTERVAL}
SM_SLOW_INTERVAL=${SM_SLOW_INTERVAL}
SM_TIMEOUT=${SM_TIMEOUT}
EOF

cd "$INSTALL_DIR"
docker compose --env-file .env -f docker-compose.agent.yml up -d --build

echo "[servermonitor-agent] docker deployment installed to $INSTALL_DIR"
echo "[servermonitor-agent] logs: cd $INSTALL_DIR && docker compose -f docker-compose.agent.yml logs -f"
