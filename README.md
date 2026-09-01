# servermonitor

`servermonitor` 是一个 TRSS-Yunzai 插件，用来集中展示多台服务器的运行状态，并把结果渲染成图片发送给管理员。

## 功能

- `#服务器状态`：查看状态图；默认包含 Yunzai 本机，并按名称展示已注册服务器
- 状态卡片为深色玻璃拟态风格，并按数量自适应布局：≤3 台单列，≥4 台双列网格
- `#服务器状态 <名称>`：查看单台服务器详情
- `#服务器状态列表`：列出所有已注册服务器
- `#服务器状态帮助`：查看插件命令帮助
- `#服务器状态待绑定`：主人私聊查看已上报但未绑定的 token（群聊中会拒绝执行）
- `#服务器状态令牌`：主人私聊查看共享上报 token
- `#服务器状态添加 <名称>`：主人私聊登记服务器并由 Yunzai 生成 token
- `#服务器状态绑定 <token>`：主人私聊接受服务器侧生成的 token，名称自动取子服务器上报名称
- `#服务器状态改名 <旧名> <新名>`：修改服务器显示名称
- `#服务器状态删除 <名称>`：主人删除已登记服务器
- `#删除服务器 <序号>`：主人按序号选择要删除的服务器
- `#确认删除服务器 <序号>`：主人二次确认后删除服务器
- `#服务器状态插件更新`：主人更新插件代码
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
4. 需要监控其他机器时，执行 `#服务器状态添加 <名称>` 生成 token 和上报地址
5. 在目标服务器上部署 `agent/` 目录并安装依赖
6. 启动 agent 后，Yunzai 就会接收并展示多机状态

## 管理命令

| 命令 | 作用 |
| --- | --- |
| `#服务器状态` | 查看总览图片；默认包含本机并显示各注册服务器 |
| `#服务器状态 <名称>` | 查看单台服务器 |
| `#服务器状态列表` | 列出注册服务器 |
| `#服务器状态帮助` | 查看插件命令帮助 |
| `#服务器状态待绑定` | 主人私聊查看已上报但未绑定的 token |
| `#服务器状态检查` | 查看插件是否加载、接口、配置和渲染状态 |
| `#服务器状态令牌` | 主人私聊查看共享上报 token，一台机器一个名字即可自动注册 |
| `#服务器状态添加 <名称>` | 主人私聊手动添加服务器并由 Yunzai 生成 token |
| `#服务器状态绑定 <token>` | 主人私聊接受服务器侧生成的 token，名称自动取子服务器上报名称 |
| `#服务器状态改名 <旧名> <新名>` | 主人修改服务器显示名称 |
| `#删除服务器 <序号>` | 主人按序号选择要删除的服务器 |
| `#确认删除服务器 <序号>` | 主人二次确认后删除服务器 |
| `#服务器状态插件更新` | 主人更新插件代码 |
| `#服务器状态删除 <名称>` | 主人删除服务器 |

## 上报 token 是什么

上报 token 是 agent 上传数据时放在请求头 `X-SM-Token` 里的密钥，用来证明这台机器是你配置的监控节点。

有两种简单用法：

### A. Yunzai 生成共享 token

主人私聊机器人发送：

```text
#服务器状态令牌
```

拿到共享 token 后，所有服务器部署 agent 时都填这个 token，并给每台机器设置不同名称，例如 `web-01`、`win-01`、`mac-01`。第一次上报时插件会自动注册服务器。

### B. 被监控机器生成 token，再回到 Yunzai 绑定

部署 agent 时 token 可以直接留空，安装器会在被监控机器生成一个 token，并输出绑定命令：

```text
#服务器状态绑定 sm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

看到 agent 输出一次上传日志后，把这条命令复制到 Yunzai 主人私聊里发送即可。服务器名称会从子服务器 agent 上报的 `name` 自动获取；之后也可以用 `#服务器状态改名 <旧名> <新名>` 修改显示名。

也就是说，最简单流程是：

```text
安装插件 → 在服务器运行一键安装器 → token 留空自动生成 → 复制绑定命令到 Yunzai 私聊
```

手动 `#服务器状态添加 <名称>` 仍然保留，适合提前由 Yunzai 给每台服务器生成独立 token。

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
shared_token: "sm_xxx" # 共享上报 token；首次启动自动生成，也可用 #服务器状态令牌 查看
public_status: false  # true 时任何人发送 #服务器状态 都会响应；false 时仅 master/admins 可查看
include_local: true   # true 时 #服务器状态 默认包含 Yunzai 本机卡片
page_size: 8          # 每张图显示服务器数量
offline_timeout: 30   # 超过多少秒未上报判定离线
```

## 部署文档

- 快速部署教程见：`快速部署教程.md`
- 详细安装步骤见：`部署文档.md`
- 服务器侧 agent 说明见：`agent/README.md`

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

GitHub 源码克隆也支持自动测速加速。安装脚本会用 `git ls-remote` 探测候选镜像，选择最快的地址克隆，失败后还会自动重试：

agent 安装脚本会自动检测本机已有的 systemd / Docker / NSSM / launchd 安装；检测到时进入更新模式，保留原 `SM_NAME`、`SM_TOKEN`、`SM_REPORT_URL`，只更新代码并重启服务。直接重跑同一条一键命令即可更新。

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
