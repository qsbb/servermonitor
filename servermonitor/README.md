# servermonitor

`servermonitor` 是一个 TRSS-Yunzai 插件，用来集中展示多台服务器的运行状态，并把结果渲染成图片发送给管理员。

## 功能

- `#服务器状态`：查看全部已注册服务器的状态图
- `#服务器状态 <名称>`：查看单台服务器详情
- `#服务器状态列表`：列出所有已注册服务器
- `#服务器状态添加 <名称>`：主人私聊登记服务器并生成 token
- `#服务器状态删除 <名称>`：主人删除已登记服务器

## 架构

当前版本采用 **Push 模式**：

1. Yunzai 作为统一接收端，暴露 `POST /servermonitor/report`
2. 每台服务器运行 `agent/agent.mjs`
3. agent 周期性采集 CPU / GPU / 内存 / 网络 / 磁盘 / 温度 / 功耗等指标
4. agent 将 JSON 快照推送到 Yunzai
5. Yunzai 侧渲染模板并回复图片

## 安装方式

1. 将整个 `servermonitor/` 目录放入 TRSS-Yunzai 的 `plugins/` 目录
2. 重启或热加载 Yunzai
3. 先执行 `#服务器状态添加 <名称>` 生成 token 和上报地址
4. 在目标服务器上部署 `agent/` 目录并安装依赖
5. 启动 agent 后，Yunzai 就会接收并展示状态

## 管理命令

| 命令 | 作用 |
| --- | --- |
| `#服务器状态` | 查看总览图片 |
| `#服务器状态 <名称>` | 查看单台服务器 |
| `#服务器状态列表` | 列出注册服务器 |
| `#服务器状态添加 <名称>` | 主人私聊添加服务器 |
| `#服务器状态删除 <名称>` | 主人删除服务器 |

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

## 部署文档

- 详细安装步骤见：`部署文档.md`
- 服务器侧 agent 说明见：`agent/README.md`

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
├── index.js
├── server.js
├── model.js
├── config.js
├── config.example.yaml
├── config.yaml              # 运行时自动生成，含 token，不建议提交
├── resources/
│   ├── server_status.html
│   └── status.css
└── agent/
    ├── agent.mjs
    ├── package.json
    ├── Dockerfile
    └── README.md
```
