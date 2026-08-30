import plugin from "../../lib/plugins/plugin.js"
import cfg from "../../lib/config/config.js"
import { CONFIG_FILE, DATA_DIR, getReportUrlPath, loadConfig } from "./config.js"
import {
  getEntries,
  getEntryByName,
  sortEntries,
  buildStatusData,
  buildTextFallback,
  listServersText,
  addServer,
  bindServerToken,
  renameServer,
  removeServer,
  listPendingTokens,
  scanOffline as scanOfflineModel,
  persist as persistModel,
  makeAgentCommand,
} from "./model.js"
import { initServerMonitorRoutes } from "./server.js"

const PLUGIN_NAME = "servermonitor"

function getMessageText(e) {
  return String(e?.msg ?? e?.raw_message ?? "").trim()
}

function parseCommandArg(text, reg) {
  const m = text.match(reg)
  return m ? m.slice(1) : null
}

export class servermonitor extends plugin {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: "多服务器统一状态监控",
      event: "message",
      priority: 5000,
      task: [
        { name: "servermonitor离线扫描", fnc: "scanOffline", cron: "*/10 * * * * *", log: false },
        { name: "servermonitor快照落盘", fnc: "persist", cron: "*/30 * * * * *", log: false },
      ],
      rule: [
        { reg: "^#?(服务器状态检查|servermonitor检查)$", fnc: "check", log: false },
        { reg: "^#?服务器状态(令牌|token|TOKEN)$", fnc: "token", permission: "master", log: false },
        { reg: "^#?服务器状态帮助$", fnc: "help", log: false },
        { reg: "^#?服务器状态列表$", fnc: "list", log: false },
        { reg: "^#?服务器状态待绑定$", fnc: "pending", permission: "master", log: false },
        { reg: "^#?服务器状态添加\\s+(\\S{1,32})(?:\\s+(.+))?$", fnc: "add", permission: "master", log: false },
        { reg: "^#?服务器状态绑定\\s+(\\S{1,32})\\s+(\\S{8,128})(?:\\s+(.+))?$", fnc: "bind", permission: "master", log: false },
        { reg: "^#?服务器状态绑定\\s+(\\S{8,128})$", fnc: "bind", permission: "master", log: false },
        { reg: "^#?服务器状态改名\\s+(\\S{1,32})\\s+(\\S{1,32})$", fnc: "rename", permission: "master", log: false },
        { reg: "^#?服务器状态删除\\s+(\\S{1,32})$", fnc: "del", permission: "master", log: false },
        { reg: "^#?服务器状态\\s+(\\S{1,32})$", fnc: "statusOne", log: false },
        { reg: "^#?服务器状态$", fnc: "statusAll", log: false },
      ],
    })
    initServerMonitorRoutes()
  }

  async _isAdmin() {
    if (this.e.isMaster) return true
    const config = await loadConfig()
    return (config.admins || []).map(String).includes(String(this.e.user_id))
  }

  async _canViewStatus() {
    const config = await loadConfig()
    if (config.public_status) return true
    if (this.e.isMaster) return true
    return (config.admins || []).map(String).includes(String(this.e.user_id))
  }

  async _replyNoPermission() {
    if (this.e.isGroup) return false
    return this.reply("权限不足：仅管理员可用")
  }

  async statusAll() {
    if (!(await this._canViewStatus())) return this._replyNoPermission()
    const config = await loadConfig()
    const entries = sortEntries(await getEntries())
    if (!entries.length) return this.reply("尚未添加服务器，请先执行 #服务器状态添加 <名称>")

    const pageSize = Math.max(1, Number(config.page_size) || 8)
    const pages = []
    for (let i = 0; i < entries.length; i += pageSize) pages.push(entries.slice(i, i + pageSize))

    const segs = []
    try {
      if (this.e?.runtime?.render) {
        for (const [idx, pageEntries] of pages.entries()) {
          const data = await buildStatusData(pageEntries, idx + 1, pages.length, entries)
          const seg = await this.e.runtime.render(PLUGIN_NAME, "server_status", data, {
            retType: "base64",
            imgType: config.render?.imgType || "png",
            saveId: `status_${Date.now()}_${idx}`,
          })
          if (seg) segs.push(seg)
        }
      }
    } catch (err) {
      ;(globalThis.logger || console).warn("[servermonitor] render status failed", err)
    }

    if (!segs.length) return this.reply(await buildTextFallback(entries))
    return this.reply(segs.length === 1 ? segs[0] : segs)
  }

  async statusOne() {
    if (!(await this._canViewStatus())) return this._replyNoPermission()
    const text = getMessageText(this.e)
    const args = parseCommandArg(text, /^#?服务器状态\s+(.+)$/)
    const name = args?.[0]?.trim()
    if (!name) return false

    const entry = await getEntryByName(name)
    if (!entry) return this.reply(`未找到服务器：${name}`)

    const config = await loadConfig()
    let seg = null
    try {
      if (this.e?.runtime?.render) {
        seg = await this.e.runtime.render(PLUGIN_NAME, "server_status", {
          summary: `服务器【${entry.name}】详情`,
          servers: [entry],
          pageNum: 1,
          pageCount: 1,
          detail: true,
          updateTime: new Date().toLocaleString(),
        }, {
          retType: "base64",
          imgType: config.render?.imgType || "png",
          saveId: `detail_${Date.now()}`,
        })
      }
    } catch (err) {
      ;(globalThis.logger || console).warn("[servermonitor] render detail failed", err)
    }
    if (!seg) return this.reply(await buildTextFallback([entry]))
    return this.reply(seg)
  }

  async list() {
    if (!(await this._canViewStatus())) return this._replyNoPermission()
    return this.reply(await listServersText())
  }

  async pending() {
    const items = await listPendingTokens()
    if (!items.length) {
      return this.reply([
        `当前没有待绑定的 token`,
        `请在子服务器启动 agent，收到一次上报后再发送：#服务器状态绑定 <token>`,
      ].join("\n"))
    }
    return this.reply([
      `【servermonitor】待绑定 token`,
      ...items.map(item => `${item.name} · ...${item.tokenTail} · ${item.ageSec}秒前上报\n#服务器状态绑定 ${item.token}`),
    ].join("\n"))
  }

  async help() {
    return this.reply([
      `【${PLUGIN_NAME}】服务器状态监控`,
      `#服务器状态            查看全部服务器`,
      `#服务器状态 <名称>     查看单台服务器`,
      `#服务器状态列表        列出已注册服务器`,
      `#服务器状态检查        查看插件加载和配置`,
      `#服务器状态令牌        查看共享上报 token`,
      `#服务器状态添加 <名称>  主人私聊添加服务器`,
      `#服务器状态绑定 <token>  按子服务器上报名称绑定`,
      `#服务器状态改名 <旧名> <新名>  修改服务器名称`,
      `#服务器状态删除 <名称>  主人删除服务器`,
    ].join("\n"))
  }

  async check() {
    const routeReady = initServerMonitorRoutes()
    const config = await loadConfig()
    const entries = await getEntries().catch(() => [])
    const baseUrl = String(cfg?.server?.url || "http://127.0.0.1:2536").replace(/\/+$/, "")
    const reportUrl = `${baseUrl}${getReportUrlPath()}`
    return this.reply([
      `【${PLUGIN_NAME}】自检`,
      `插件加载：正常`,
      `HTTP接口：${routeReady ? "已注册" : "等待 Bot.express"}`,
      `上报地址：${reportUrl}`,
      `配置文件：${CONFIG_FILE}`,
      `数据目录：${DATA_DIR}`,
      `注册服务器：${config.servers?.length || 0} 台`,
      `当前展示：${entries.map(i => i.name).join("、") || "空"}`,
      `public_status：${config.public_status ? "true" : "false"}`,
      `include_local：${config.include_local ? "true" : "false"}`,
      `shared_token：${config.shared_token ? "已生成" : "未生成"}`,
      `runtime.render：${this.e?.runtime?.render ? "可用" : "未检测到"}`,
    ].join("\n"))
  }

  async token() {
    if (this.e.isGroup) return this.reply("为保护 token，请私聊我执行：#服务器状态令牌")
    const config = await loadConfig(true)
    const baseUrl = String(cfg?.server?.url || "http://127.0.0.1:2536").replace(/\/+$/, "")
    const reportUrl = `${baseUrl}${getReportUrlPath()}`
    return this.reply([
      `【${PLUGIN_NAME}】共享上报 token`,
      `token：${config.shared_token}`,
      `上报地址：${reportUrl}`,
      `说明：agent 使用这个 token 上报时，会按 --name / SM_NAME 自动注册服务器。`,
      `另一种方式：部署机器先生成 token，再私聊执行 #服务器状态绑定 <名称> <token>。`,
      `Linux一键：sudo bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-linux.sh) web-01 ${config.shared_token} ${reportUrl}`,
      `Docker一键：sudo bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-docker.sh) web-01 ${config.shared_token} ${reportUrl}`,
      `macOS一键：sudo bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-macos.sh) mac-01 ${config.shared_token} ${reportUrl}`,
      `Windows：运行 install.ps1 后填入 win-01、上方 token、上方上报地址`,
    ].join("\n"))
  }

  async add() {
    const text = getMessageText(this.e)
    const args = parseCommandArg(text, /^#?服务器状态添加\s+(\S{1,32})(?:\s+(.+))?$/)
    const name = args?.[0]?.trim()
    const note = args?.[1]?.trim() || ""
    if (!name) return false
    if (this.e.isGroup) {
      return this.reply("为保护 token，请私聊我执行此命令")
    }

    try {
      const item = await addServer(name, note)
      const baseUrl = String(cfg?.server?.url || "http://127.0.0.1:2536")
      const command = makeAgentCommand({
        baseUrl,
        name: item.name,
        token: item.token,
        interval: 10,
      })
      const hint = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1")
        ? "提示：servermonitor 复用 Yunzai HTTP 服务端口，只新增 /servermonitor/report 路径；当前地址是本机地址，请改成 agent 能访问到的公网/内网地址。"
        : "提示：servermonitor 复用 Yunzai HTTP 服务端口，只新增 /servermonitor/report 路径，不额外占用端口。"
      return this.reply([
        `已添加服务器【${item.name}】`,
        item.note ? `备注：${item.note}` : null,
        `token：${item.token}`,
        `上报接口：${baseUrl.replace(/\/+$/, "")}/servermonitor/report`,
        `请在服务器的 agent 目录中执行以下命令：`,
        command,
        hint || null,
      ].filter(Boolean).join("\n"))
    } catch (err) {
      return this.reply(`添加失败：${err.message || err}`)
    }
  }

  async bind() {
    const text = getMessageText(this.e)
    const named = parseCommandArg(text, /^#?服务器状态绑定\s+(\S{1,32})\s+(\S{8,128})(?:\s+(.+))?$/)
    const tokenOnly = parseCommandArg(text, /^#?服务器状态绑定\s+(\S{8,128})$/)
    const name = named?.[0]?.trim() || ""
    const token = named?.[1]?.trim() || tokenOnly?.[0]?.trim() || ""
    const note = named?.[2]?.trim() || "设备侧生成 token"
    if (!token) return false
    if (this.e.isGroup) return this.reply("为保护 token，请私聊我执行绑定命令")

    try {
      const item = name ? await bindServerToken(name, token, note) : await bindServerToken(token)
      return this.reply([
        item.alreadyBound ? `token 已绑定服务器【${item.name}】` : `已绑定服务器【${item.name}】`,
        `token：${item.token}`,
        `备注：${item.note || "无"}`,
        `可发送 #服务器状态 查看。`,
      ].join("\n"))
    } catch (err) {
      return this.reply(`绑定失败：${err.message || err}`)
    }
  }

  async rename() {
    const text = getMessageText(this.e)
    const args = parseCommandArg(text, /^#?服务器状态改名\s+(\S{1,32})\s+(\S{1,32})$/)
    const oldName = args?.[0]?.trim()
    const newName = args?.[1]?.trim()
    if (!oldName || !newName) return false

    try {
      const item = await renameServer(oldName, newName)
      return this.reply(`已改名：${oldName} → ${item.name}`)
    } catch (err) {
      return this.reply(`改名失败：${err.message || err}`)
    }
  }

  async del() {
    const text = getMessageText(this.e)
    const args = parseCommandArg(text, /^#?服务器状态删除\s+(\S{1,32})$/)
    const name = args?.[0]?.trim()
    if (!name) return false

    try {
      await removeServer(name)
      return this.reply(`已删除服务器【${name}】`)
    } catch (err) {
      return this.reply(`删除失败：${err.message || err}`)
    }
  }

  async scanOffline() {
    initServerMonitorRoutes()
    return await scanOfflineModel()
  }

  async persist() {
    initServerMonitorRoutes()
    return await persistModel()
  }
}
