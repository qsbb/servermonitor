# servermonitor agent

这是 `servermonitor` 的服务器侧采集程序。快速部署见上级目录的 `快速部署教程.md`，完整部署流程见上级目录的 `部署文档.md`。

## 一键部署

Linux systemd：

```bash
sudo bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-linux.sh) \
  web-01 http://192.168.1.10:2536/servermonitor/report
```

Linux Docker：

```bash
sudo bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-docker.sh) \
  web-01 http://192.168.1.10:2536/servermonitor/report
```

Windows 管理员 PowerShell：

```powershell
irm https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-windows.ps1 -OutFile $env:TEMP\install-agent-windows.ps1
powershell -ExecutionPolicy Bypass -File $env:TEMP\install-agent-windows.ps1 -Name "win-01" -ReportUrl "http://192.168.1.10:2536/servermonitor/report"
```

macOS launchd：

```bash
sudo bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-macos.sh) \
  mac-01 http://192.168.1.10:2536/servermonitor/report
```

上面这些命令省略 token 时，脚本会在被监控机器生成 token，并输出：

```text
#服务器状态绑定 <token>
```

把它复制到 Yunzai 主人私聊里发送即可完成绑定，服务器名称会从 agent 上报的 `SM_NAME` / `--name` 自动获取；后续可用 `#服务器状态改名 <旧名> <新名>` 修改显示名称。

## 依赖

- Node.js 18+
- `systeminformation`

安装依赖：

```bash
npm install --omit=dev
```

## 内存统计口径

- agent 保留 `mem.used` 和 `mem.total`，并额外上报可选的 `mem.available`。
- Linux 下 `systeminformation.mem().available` 对应系统的 `MemAvailable`，面板使用 `total - available` 表示实际内存压力，避免把可回收 page cache 当成正在占用。
- 无法获得可信 `available` 时传 `null`，服务端会回退到旧的 `used` 口径；不要用 `total - used` 伪造该字段。
- Docker/cgroup 限额识别不属于当前实现，容器中仍可能看到宿主机口径。

## 命令行启动

一次性上传：

```bash
node agent.mjs \
  --name web-01 \
  --token sm_xxx \
  --report-url http://yunzai.example.com/servermonitor/report \
  --once
```

持续运行：

```bash
node agent.mjs \
  --name web-01 \
  --token sm_xxx \
  --report-url http://yunzai.example.com/servermonitor/report \
  --interval 10 \
  --slow-interval 30
```

## 环境变量启动

Docker、systemd、launchd、NSSM 都可以使用环境变量：

```bash
export SM_NAME=web-01
export SM_TOKEN=sm_xxx
export SM_REPORT_URL=http://yunzai.example.com/servermonitor/report
export SM_INTERVAL=10
export SM_SLOW_INTERVAL=30
node agent.mjs
```

支持的环境变量：

| 环境变量 | 对应参数 | 说明 |
| --- | --- | --- |
| `SM_NAME` | `--name` | 服务器名称 |
| `SM_TOKEN` | `--token` | 上报 token |
| `SM_REPORT_URL` | `--report-url` | Yunzai 上报地址 |
| `SM_INTERVAL` | `--interval` | 基础上传间隔，秒 |
| `SM_SLOW_INTERVAL` | `--slow-interval` | 慢速采集间隔，秒 |
| `SM_TIMEOUT` | `--timeout` | 上传超时，毫秒 |
| `SM_DRY_RUN` | `--dry-run` | 只输出快照 |
| `SM_ONCE` | `--once` | 上传一次后退出 |

## Docker Compose

仓库根目录提供 `docker-compose.agent.yml` 和 `.env.agent.example`：

```bash
cp .env.agent.example .env
# 编辑 .env 后启动
docker compose --env-file .env -f docker-compose.agent.yml up -d --build
```

Dockerfile 支持通过 `.env` 指定基础镜像：

```dotenv
NODE_IMAGE=node:18-bookworm-slim
```

一键 Docker 安装脚本会自动测速候选镜像并写入最快的 `NODE_IMAGE`。

查看日志：

```bash
docker compose -f docker-compose.agent.yml logs -f
```

## systemd 服务示例

一键安装脚本会把名称、token、上报地址写入 agent 目录的 `servermonitor-agent.json`（权限 0600），unit 只保留启动命令，避免 token 出现在 `systemctl show` 输出里：

```ini
[Unit]
Description=servermonitor agent
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/servermonitor/agent
ExecStart=/usr/bin/node /opt/servermonitor/agent/agent.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

手动部署时也可以继续使用 `Environment=` 或环境变量；命令行参数优先级最高，其次是环境变量，最后是 `servermonitor-agent.json`。

## Windows NSSM 示例

```powershell
nssm install servermonitor-agent "C:\Program Files\nodejs\node.exe" "C:\servermonitor\agent\agent.mjs"
nssm set servermonitor-agent AppDirectory "C:\servermonitor\agent"
nssm set servermonitor-agent AppEnvironmentExtra "SM_NAME=win-01" "SM_TOKEN=sm_xxx" "SM_REPORT_URL=http://yunzai.example.com/servermonitor/report"
nssm start servermonitor-agent
```

## macOS launchd

一键脚本会生成 `/Library/LaunchDaemons/com.servermonitor.agent.plist`。手动 plist 示例见 `部署文档.md`。
