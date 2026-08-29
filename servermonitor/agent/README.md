# servermonitor agent

这是 `servermonitor` 的服务器侧采集程序。完整部署流程见上级目录的 `部署文档.md`。

## 依赖

- Node.js 18+
- `systeminformation`

安装依赖：

```bash
npm install
```

## 启动

### 一次性上传

```bash
node agent.mjs \
  --name web-01 \
  --token sm_xxx \
  --report-url http://yunzai.example.com/servermonitor/report \
  --once
```

### 持续运行

```bash
node agent.mjs \
  --name web-01 \
  --token sm_xxx \
  --report-url http://yunzai.example.com/servermonitor/report \
  --interval 10 \
  --slow-interval 30
```

## 常用参数

- `--name`：服务器名，必须与 Yunzai 中注册的名称一致
- `--token`：Yunzai 生成的上报 token
- `--report-url`：Yunzai 上报地址
- `--interval`：基础上传间隔，单位秒
- `--slow-interval`：慢速采集间隔，单位秒
- `--dry-run`：只输出快照，不上报
- `--once`：采集一次并退出

## Linux 服务示例

可用 systemd、Docker 或 Supervisor 托管。示例：

```ini
[Unit]
Description=servermonitor agent
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/servermonitor/agent
ExecStart=/usr/bin/node /opt/servermonitor/agent/agent.mjs --name web-01 --token sm_xxx --report-url http://yunzai.example.com/servermonitor/report
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Windows

建议使用 Windows Service 或 NSSM 托管：

```powershell
nssm install servermonitor-agent "C:\Program Files\nodejs\node.exe" "C:\servermonitor\agent\agent.mjs" --name web-01 --token sm_xxx --report-url http://yunzai.example.com/servermonitor/report
```

## macOS

建议使用 launchd 或 `plist` 托管。

## Docker

目录内提供了 `Dockerfile`，可直接构建：

```bash
docker build -t servermonitor-agent ./agent
```

运行时建议至少启用 `--network host`，宿主机指标采集更完整时还可以加 `--pid host`、挂载 `/proc` 和 `/sys`：

```bash
docker run --rm \
  --network host \
  --pid host \
  -v /proc:/host/proc:ro \
  -v /sys:/host/sys:ro \
  servermonitor-agent \
  node agent.mjs --name web-01 --token sm_xxx --report-url http://yunzai.example.com/servermonitor/report
```
