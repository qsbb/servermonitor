# servermonitor

`servermonitor` 是一个面向 TRSS-Yunzai 的多服务器状态监控插件。

- Yunzai 端：插件接收 agent 上报并渲染图片
- 服务器端：Node.js agent 主动 Push 指标
- 支持 Linux / Windows / macOS
- 支持 CPU / GPU / 内存 / 网络 / 磁盘 / 温度 / 功耗等指标

## 项目目录

```text
server-status-plugin/
├── README.md
├── 开发文档.md
└── servermonitor/
    ├── README.md
    ├── 部署文档.md
    ├── index.js
    ├── server.js
    ├── model.js
    ├── local.js
    ├── config.js
    ├── package.json
    ├── resources/
    └── agent/
```

## 快速开始

1. 将 `servermonitor/` 复制到 TRSS-Yunzai 的 `plugins/` 目录
2. 重启或热加载 Yunzai
3. 直接发送 `#服务器状态` 可先查看 Yunzai 本机状态
4. 需要监控其他机器时，主人私聊执行：

```text
#服务器状态添加 web-01
```

5. 在服务器上部署 `servermonitor/agent/` 并运行机器人返回的 agent 命令
6. 发送：

```text
#服务器状态
```

即可获得全部服务器状态图片。

## 文档

- 插件说明：`servermonitor/README.md`
- 部署文档：`servermonitor/部署文档.md`
- agent 文档：`servermonitor/agent/README.md`
- 开发设计：`开发文档.md`

## License

MIT
