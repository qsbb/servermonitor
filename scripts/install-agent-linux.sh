#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/qsbb/servermonitor.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/servermonitor/agent}"
SERVICE_NAME="${SERVICE_NAME:-servermonitor-agent}"
SM_NAME="${SM_NAME:-${1:-}}"
SM_TOKEN="${SM_TOKEN:-${2:-}}"
SM_REPORT_URL="${SM_REPORT_URL:-${3:-}}"
if [[ -z "$SM_REPORT_URL" && "$SM_TOKEN" =~ ^https?:// ]]; then
  SM_REPORT_URL="$SM_TOKEN"
  SM_TOKEN=""
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

echo "[servermonitor-agent] cloning $REPO_URL#$BRANCH"
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$TMP_DIR/servermonitor"

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
Environment=SM_NAME=${SM_NAME}
Environment=SM_TOKEN=${SM_TOKEN}
Environment=SM_REPORT_URL=${SM_REPORT_URL}
Environment=SM_INTERVAL=${SM_INTERVAL}
Environment=SM_SLOW_INTERVAL=${SM_SLOW_INTERVAL}
Environment=SM_TIMEOUT=${SM_TIMEOUT}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/agent.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

echo "[servermonitor-agent] installed to $INSTALL_DIR"
echo "[servermonitor-agent] service: $SERVICE_NAME"
echo "[servermonitor-agent] status: systemctl status $SERVICE_NAME"
echo "[servermonitor-agent] logs: journalctl -u $SERVICE_NAME -f"
echo "[servermonitor-agent] token: $SM_TOKEN"
echo "[servermonitor-agent] bind in Yunzai private chat: #服务器状态绑定 $SM_NAME $SM_TOKEN"
