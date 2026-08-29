import plugin from "../../lib/plugins/plugin.js"
import cfg from "../../lib/config/config.js"
import { loadConfig } from "./config.js"
import {
  getEntries,
  getEntryByName,
  sortEntries,
  buildStatusData,
  buildTextFallback,
  listServersText,
  addServer,
  removeServer,
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
        { reg: "^#?服务器状态帮助$", fnc: "help", log: false },
        { reg: "^#?服务器状态列表$", fnc: "list", log: false },
        { reg: "^#?服务器状态添加\\s+(\\S{1,32})(?:\\s+(.+))?$", fnc: "add", permission: "master", log: false },
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

  async _replyNoPermission() {
    if (this.e.isGroup) return false
    return this.reply("权限不足：仅管理员可用")
  }

  async statusAll() {
    if (!(await this._isAdmin())) return this._replyNoPermission()
    const config = await loadConfig()
    const entries = sortEntries(await getEntries())
    if (!entries.length) return this.reply("尚未添加服务器，请先执行 #服务器状态添加 <名称>")

    const pageSize = Math.max(1, Number(config.page_size) || 8)
    const pages = []
    for (let i = 0; i < entries.length; i += pageSize) pages.push(entries.slice(i, i + pageSize))

    const segs = []
    for (const [idx, pageEntries] of pages.entries()) {
      const data = await buildStatusData(pageEntries, idx + 1, pages.length, entries)
      const seg = await this.e.runtime.render(PLUGIN_NAME, "server_status", data, {
        retType: "base64",
        imgType: config.render?.imgType || "png",
        saveId: `status_${Date.now()}_${idx}`,
      })
      if (seg) segs.push(seg)
    }

    if (!segs.length) return this.reply(await buildTextFallback(entries))
    return this.reply(segs.length === 1 ? segs[0] : segs)
  }

  async statusOne() {
    if (!(await this._isAdmin())) return this._replyNoPermission()
    const text = getMessageText(this.e)
    const args = parseCommandArg(text, /^#?服务器状态\s+(.+)$/)
    const name = args?.[0]?.trim()
    if (!name) return false

    const entry = await getEntryByName(name)
    if (!entry) return this.reply(`未找到服务器：${name}`)

    const config = await loadConfig()
    const seg = await this.e.runtime.render(PLUGIN_NAME, "server_status", {
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
    if (!seg) return this.reply(await buildTextFallback([entry]))
    return this.reply(seg)
  }

  async list() {
    if (!(await this._isAdmin())) return this._replyNoPermission()
    return this.reply(await listServersText())
  }

  async help() {
    return this.reply([
      `【${PLUGIN_NAME}】服务器状态监控`,
      `#服务器状态            查看全部服务器`,
      `#服务器状态 <名称>     查看单台服务器`,
      `#服务器状态列表        列出已注册服务器`,
      `#服务器状态添加 <名称>  主人私聊添加服务器`,
      `#服务器状态删除 <名称>  主人删除服务器`,
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
        ? "提示：当前 Yunzai 地址是本机地址，请改成 agent 能访问到的公网/内网地址。"
        : ""
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
