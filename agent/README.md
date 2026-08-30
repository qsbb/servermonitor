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
#服务器状态绑定 <名称> <token>
```

把它复制到 Yunzai 主人私聊里发送即可完成绑定。

## 依赖

- Node.js 18+
- `systeminformation`

安装依赖：

```bash
npm install --omit=dev
```

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

查看日志：

```bash
docker compose -f docker-compose.agent.yml logs -f
```

## systemd 服务示例

```ini
[Unit]
Description=servermonitor agent
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/servermonitor/agent
Environment=SM_NAME=web-01
Environment=SM_TOKEN=sm_xxx
Environment=SM_REPORT_URL=http://yunzai.example.com/servermonitor/report
ExecStart=/usr/bin/node /opt/servermonitor/agent/agent.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Windows NSSM 示例

```powershell
nssm install servermonitor-agent "C:\Program Files\nodejs\node.exe" "C:\servermonitor\agent\agent.mjs"
nssm set servermonitor-agent AppDirectory "C:\servermonitor\agent"
nssm set servermonitor-agent AppEnvironmentExtra "SM_NAME=win-01" "SM_TOKEN=sm_xxx" "SM_REPORT_URL=http://yunzai.example.com/servermonitor/report"
nssm start servermonitor-agent
```

## macOS launchd

一键脚本会生成 `/Library/LaunchDaemons/com.servermonitor.agent.plist`。手动 plist 示例见 `部署文档.md`。
