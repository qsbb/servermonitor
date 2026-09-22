# servermonitor

`servermonitor` 是一个 TRSS-Yunzai 插件，用来集中展示多台服务器的运行状态，并把结果渲染成图片发送给管理员。

## 功能

- `#服务器状态`：查看状态图；默认包含 Yunzai 本机，并按名称展示已注册服务器
- 状态卡片为深色玻璃拟态风格，并按数量自适应布局：≤3 台单列，≥4 台双列网格
- Linux / Docker / Windows / macOS 一键部署 agent

## 架构

当前版本采用 **Push 模式**：

1. Yunzai 作为统一接收端，暴露 `POST /servermonitor/report`
2. 每台服务器运行 `agent/agent.mjs`
3. agent 周期性采集 CPU / GPU / 内存 / 网络 / 磁盘 / 温度 / 功耗等指标
4. agent 将 JSON 快照推送到 Yunzai
5. Yunzai 侧渲染模板并回复图片

## 安装方式

在 Yunzai 根目录执行：

```bash
cd /path/to/Yunzai
# 首次安装
git clone https://github.com/qsbb/servermonitor.git plugins/servermonitor
# 更新已有安装（保留 config.yaml 和 data/）
cd plugins/servermonitor && git pull --ff-only
```

确认入口文件存在：

```bash
ls plugins/servermonitor/index.js
```

如果路径变成 `plugins/servermonitor/servermonitor/index.js`，插件不会被加载，需要重新按上面的命令安装。

然后：

1. 重启或热加载 Yunzai
2. 发送 `#服务器状态检查` 验证插件已加载
3. 直接发送 `#服务器状态` 可查看 Yunzai 本机状态
4. 需要监控其他机器时，执行 `#服务器状态添加 <名称> [上报地址]` 生成 token 和启动命令
5. 在目标服务器上部署 `agent/` 目录并安装依赖
6. 启动 agent 后，Yunzai 就会接收并展示多机状态

## 升级（Linux）

### 1. 先升级 Yunzai 插件

```bash
cd /path/to/Yunzai
git -C plugins/servermonitor pull --ff-only
```

或主人私聊发送 `#服务器状态插件更新`，然后重启 Yunzai 并发送 `#服务器状态检查`。

> 0.1.19 起共享 token 已停用：agent 如果还在用旧共享 token，会收到 `401 shared token disabled`。在主人私聊执行 `#服务器状态命令 <名称>` 取回独立 token，再更新 agent 配置。

### 2. 更新 systemd agent

重复执行同一条一键命令即可，会自动沿用原名称、token 和上报地址：

```bash
sudo bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-linux.sh)
```

更新采用“先装后切”：先在临时目录安装依赖并自检，通过后才停服务切换；任何一步失败都会恢复旧版本并重启旧服务。

### 3. 更新 Docker agent

```bash
sudo bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-docker.sh)
```

### 4. 验证

```bash
systemctl status servermonitor-agent --no-pager
journalctl -u servermonitor-agent -n 30 --no-pager     # 应出现 uploaded
grep -m1 AGENT_VERSION /opt/servermonitor/agent/agent.mjs   # 应为 0.1.19
sudo ls -l /opt/servermonitor/agent/servermonitor-agent.json   # 权限应为 600
```

## 管理命令

| 命令 | 作用 |
| --- | --- |
| `#服务器状态` | 查看总览图片；默认包含本机并显示各注册服务器 |
| `#服务器状态 <名称>` | 查看单台服务器 |
| `#服务器状态列表` | 列出注册服务器 |
| `#服务器状态帮助` | 查看插件命令帮助 |
| `#服务器状态待绑定` | 主人私聊查看已上报但未绑定的 token |
| `#服务器状态检查` | 查看插件是否加载、接口、配置和渲染状态 |
| `#服务器状态命令 <名称>` | 主人私聊重新获取该服务器的独立 token 与启动命令 |
| `#服务器状态令牌` | 已停用，返回迁移说明 |
| `#服务器状态添加 <名称> [上报地址] [备注]` | 主人私聊手动添加服务器并生成 token；地址必须带 `http://` 或 `https://` |
| `#服务器状态绑定 <token>` 或 `#服务器状态绑定 <名称> <token>` | 主人私聊绑定服务器侧生成的 token |
| `#服务器状态改名 <旧名> <新名>` | 主人修改服务器显示名称 |
| `#删除服务器 <名称\|序号>` | 主人删除服务器；无参数时列出服务器，按序号删除需二次确认 |
| `#确认删除服务器 <序号>` | 主人二次确认后删除服务器 |
| `#服务器状态插件更新` | 主人更新插件代码 |

> 地址不带 `http://` 时会被识别为“看起来像地址但缺协议”并给出重发提示；只写域名不会再静默保存成备注。

## 上报 token 是什么

上报 token 是 agent 上传数据时放在请求头 `X-SM-Token` 里的密钥，用来证明这台机器是你配置的监控节点。

每个服务器使用一个独立 token；共享 token 已停用，携带旧共享 token 的上报会返回 `401` 和迁移提示。

### A. 被监控机器生成 token，再回到 Yunzai 绑定

部署 agent 时 token 可以直接留空，安装器会在被监控机器生成一个 token，并输出绑定命令：

```text
#服务器状态绑定 sm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

看到 agent 输出一次上传日志后，把这条命令复制到 Yunzai 主人私聊里发送即可。服务器名称会从子服务器 agent 上报的 `name` 自动获取；之后也可以用 `#服务器状态改名 <旧名> <新名>` 修改显示名。

也就是说，最简单流程是：

```text
安装插件 → 在服务器运行一键安装器 → token 留空自动生成 → 复制绑定命令到 Yunzai 私聊
```

### B. 由 Yunzai 生成单机 token

手动添加适合提前由 Yunzai 给每台服务器生成独立 token，例如：

```text
#服务器状态添加 4c4g http://lingxiz.cn:2536
```

地址也可填写完整的 `/servermonitor/report` 接口；省略地址时使用 Yunzai 的 `server.url` 配置。命令回复中的上报地址和 agent 启动命令始终保持一致。

## 上报协议

- 地址：`POST /servermonitor/report`
- 请求头：`X-SM-Token: <token>`
- 请求体示例：

```json
{
  "v": 1,
  "name": "web-01",
  "agent_ts": 1730000000000,
  "os": {},
  "cpu": {},
  "gpus": [],
  "mem": {},
  "net": {},
  "disks": [],
  "load": []
}
```

## 配置文件

- `config.example.yaml`：示例配置，可复制为 `config.yaml`
- `config.yaml`：运行时配置，首次启动可自动生成，包含服务器 token，请勿公开
- `data/snapshots.json`：最近一次持久在线快照

常用配置：

```yaml
trusted_proxies: []   # 仅当使用可信反向代理时填写；默认只信任 TCP 直连地址
report_enabled: true  # false 时停止接收所有上报
public_status: false  # true 时任何人发送 #服务器状态 都会响应；false 时仅 master/admins 可查看
include_local: true   # true 时 #服务器状态 默认包含 Yunzai 本机卡片
page_size: 8          # 每张图显示服务器数量
offline_timeout: 30   # 超过多少秒未上报判定离线
```

## 部署文档

- 快速部署教程见：`快速部署教程.md`
- 详细安装步骤见：`部署文档.md`
- 服务器侧 agent 说明见：`agent/README.md`
- 第三方工具箱接入见：[`docs/适配文档-第三方工具箱上报.md`](docs/适配文档-第三方工具箱上报.md)

一键安装器：

下载仓库后可直接运行：

```bash
./install.sh
```

Windows 可运行：

```powershell
.\install.ps1
```

也可以使用远程一键命令：

| 场景 | 命令 |
| --- | --- |
| 交互式一键安装器 | `bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install.sh)` |
| Windows 交互式一键安装器 | 下载 `scripts/install.ps1` 后执行 `powershell -ExecutionPolicy Bypass -File install.ps1` |
| 安装 Yunzai 插件 | `bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-plugin.sh) /path/to/Yunzai` |
| Linux systemd agent | `sudo bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-linux.sh) web-01 http://YUNZAI:2536/servermonitor/report` |
| Docker agent | `sudo bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-docker.sh) web-01 http://YUNZAI:2536/servermonitor/report` |
| Windows agent | `irm https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-windows.ps1 -OutFile $env:TEMP\\install-agent-windows.ps1` |
| macOS launchd agent | `sudo bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-macos.sh) mac-01 http://YUNZAI:2536/servermonitor/report` |
| Windows 单文件 exe | 从 Release 下载 `servermonitor-agent.exe`，双击配置并开启开机自启 |

GitHub 源码克隆也支持自动测速加速。安装脚本会用 `git ls-remote` 探测候选镜像，选择最快的地址克隆，失败后还会自动重试。官方仓库可达时始终优先官方地址；如果自动选中了第三方镜像、但官方仓库此刻不可达导致镜像新鲜度无法校验，安装会直接中止（避免把滞后镜像的旧版本当作更新装上）。确认要承担风险时可显式放行：

```bash
ALLOW_UNVERIFIED_MIRROR=1 \
  sudo bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-linux.sh) web-01 http://YUNZAI:2536/servermonitor/report
```


agent 安装脚本会自动检测本机已有的 systemd / Docker / NSSM / launchd 安装；检测到时进入更新模式。Linux / macOS 更新采用“先装后切”：先在临时目录安装依赖并自检，通过后才停服务切换；任何一步失败都会恢复旧版本并重启。配置与 token 保存在 agent 目录的 `servermonitor-agent.json`（权限 0600），systemd unit / launchd plist 不再内嵌密钥。直接重跑同一条一键命令即可更新。

```bash
REPO_MIRRORS="https://github.com/qsbb/servermonitor.git,https://ghfast.top/https://github.com/qsbb/servermonitor.git" \
  sudo bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-docker.sh) web-01 http://YUNZAI:2536/servermonitor/report
```

关闭 GitHub 镜像测速：

```bash
AUTO_GIT_MIRROR=0 sudo bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install.sh)
```

Docker 版安装器会自动测速多个 Node 基础镜像地址，选择最快的 `NODE_IMAGE` 写入 `.env` 后再构建。可用环境变量覆盖：

```bash
NODE_IMAGE=registry.example.com/library/node:18-bookworm-slim \
  sudo bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-docker.sh) web-01 http://YUNZAI:2536/servermonitor/report
```

也可关闭测速：

```bash
AUTO_NODE_IMAGE=0 sudo bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-docker.sh) web-01 http://YUNZAI:2536/servermonitor/report
```

## 端口说明

`2536` 通常是 TRSS-Yunzai 的 HTTP 服务端口。`servermonitor` 不会额外监听新端口，只是在同一个 `Bot.express` 上新增：

```text
POST /servermonitor/report
```

所以它和 OneBotV11 同端口时是不同 HTTP 路径，不是两个程序抢占同一个端口。只有当另一个独立进程已经绑定了同一个端口时，才需要调整 Yunzai 的 HTTP 服务端口。

## 运行要求

- Yunzai 端：TRSS-Yunzai + 具备 HTTP 接口能力
- agent 端：Node.js 18+
- 建议全链路使用 HTTPS 或内网访问

## 安全建议

- `token` 必须保密，建议只在私网或反向代理后暴露接口
- 不要开启 shell / SSH 远程执行，只保留本插件的上传接口
- 生产环境建议给上报接口加 IP 白名单或网关认证
- 禁用或卸载本插件后请重启 Yunzai：Express 路由不会随插件卸载自动注销
- TRSS 的 debug 级 HTTP 日志会记录完整 `X-SM-Token`，排障结束后请调回 info，不要长期开启 debug
- `config.yaml`、`pending.json` 与 agent 配置默认以 0600 权限写入，请勿改成其他用户可读

## 目录说明

```text
servermonitor/
├── README.md
├── 快速部署教程.md
├── 部署文档.md
├── install.sh               # Linux/macOS 交互式安装器入口
├── install.ps1              # Windows 交互式安装器入口
├── index.js
├── server.js
├── model.js
├── local.js
├── config.js
├── package.json
├── config.example.yaml
├── config.yaml              # 运行时自动生成，含 token，不建议提交
├── docker-compose.agent.yml # Docker Compose 部署 agent
├── .env.agent.example       # Docker agent 环境变量示例
├── scripts/                 # 一键部署脚本
├── resources/
│   ├── server_status.html
│   └── status.css
└── agent/
    ├── agent.mjs
    ├── package.json
    ├── Dockerfile
    └── README.md
```
