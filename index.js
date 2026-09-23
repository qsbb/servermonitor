import plugin from "../../lib/plugins/plugin.js"
import cfg from "../../lib/config/config.js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { CONFIG_FILE, DATA_DIR, ROOT_DIR, getReportUrlPath, loadConfig } from "./config.js"
import {
  getEntries,
  sortEntriesByCardLength,
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
  buildAddServerReply,
  buildServerCommand,
  buildServerCommandReply,
  isLoopbackReportUrl,
  looksLikeAddressWithoutScheme,
  makeAgentCommand,
  normalizeReportUrl,
  parseAddServerExtra,
  parseDeleteTarget,
  usageHintFor,
} from "./model.js"
import { initServerMonitorRoutes } from "./server.js"

const PLUGIN_NAME = "servermonitor"
const execFileAsync = promisify(execFile)
const deleteConfirmations = new Map()
const DELETE_CONFIRM_TTL = 5 * 60 * 1000

function sortedServers(config) {
  return [...(config?.servers || [])].sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN"))
}

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
        {
          name: "servermonitor离线扫描",
          fnc: async () => {
            initServerMonitorRoutes()
            await scanOfflineModel()
          },
          cron: "*/10 * * * * *",
          log: false,
        },
        {
          name: "servermonitor快照落盘",
          fnc: async () => {
            initServerMonitorRoutes()
            await persistModel()
          },
          cron: "*/30 * * * * *",
          log: false,
        },
      ],
      rule: [
        { reg: "^#?(服务器状态检查|servermonitor检查)$", fnc: "check", log: false },
        { reg: "^#?服务器状态(令牌|token|TOKEN)$", fnc: "token", permission: "master", log: false },
        { reg: "^#?服务器状态帮助$", fnc: "help", log: false },
        { reg: "^#?服务器状态列表$", fnc: "list", log: false },
        { reg: "^#?服务器状态待绑定$", fnc: "pending", permission: "master", log: false },
        { reg: "^#?服务器状态添加\\s+(\\S{1,32})(?:\\s+(.+))?$", fnc: "add", permission: "master", log: false },
        { reg: "^#?服务器状态命令\\s+(\\S{1,32})$", fnc: "command", permission: "master", log: false },
        { reg: "^#?服务器状态绑定\\s+(\\S{1,32})\\s+(\\S{8,128})(?:\\s+(.+))?$", fnc: "bind", permission: "master", log: false },
        { reg: "^#?服务器状态绑定\\s+(\\S{8,128})$", fnc: "bind", permission: "master", log: false },
        { reg: "^#?服务器状态改名\\s+(\\S{1,32})\\s+(\\S{1,32})$", fnc: "rename", permission: "master", log: false },
        { reg: "^#?服务器状态删除\\s+(\\S{1,32})$", fnc: "del", permission: "master", log: false },
        { reg: "^#?删除服务器$", fnc: "deleteByIndex", permission: "master", log: false },
        { reg: "^#?删除服务器\\s*[+＋]?\\s*(\\S+)$", fnc: "deleteTarget", permission: "master", log: false },
        { reg: "^#?确认删除服务器$", fnc: "confirmDelete", permission: "master", log: false },
        { reg: "^#?确认删除服务器\\s*[+＋]?\\s*(\\d+)$", fnc: "confirmDelete", permission: "master", log: false },
        { reg: "^#?服务器状态插件更新$", fnc: "updatePlugin", permission: "master", log: false },
        { reg: "^#?服务器状态添加$", fnc: "usage", permission: "master", log: false },
        { reg: "^#?服务器状态绑定$", fnc: "usage", permission: "master", log: false },
        { reg: "^#?服务器状态改名$", fnc: "usage", permission: "master", log: false },
        { reg: "^#?服务器状态改名\\s+\\S+$", fnc: "usage", permission: "master", log: false },
        { reg: "^#?服务器状态命令$", fnc: "usage", permission: "master", log: false },
        { reg: "^#?服务器状态删除$", fnc: "usage", permission: "master", log: false },
        { reg: "^#?服务器状态\\s*pro$", fnc: "statusPro", log: false },
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
    return this._statusOverview(false)
  }

  async statusPro() {
    return this._statusOverview(true)
  }

  async _statusOverview(pro) {
    if (!(await this._canViewStatus())) return this._replyNoPermission()
    const config = await loadConfig()
    const entries = pro
      ? sortEntriesByCardLength(await getEntries({ pro: true }))
      : sortEntries(await getEntries())
    if (!entries.length) return this.reply("尚未添加服务器，请先执行 #服务器状态添加 <名称>")

    const pageSize = Math.max(1, Number(config.page_size) || 8)
    const pages = []
    for (let i = 0; i < entries.length; i += pageSize) pages.push(entries.slice(i, i + pageSize))

    const segs = []
    if (this.e?.runtime?.render) {
      for (const [idx, pageEntries] of pages.entries()) {
        try {
          const data = await buildStatusData(pageEntries, idx + 1, pages.length, entries, config, { pro })
          const seg = await this.e.runtime.render(PLUGIN_NAME, "server_status", data, {
            retType: "base64",
            imgType: config.render?.imgType || "png",
            saveId: `servermonitor_status${pro ? "_pro" : ""}_p${idx + 1}_of_${pages.length}`,
          })
          if (seg) segs.push(seg)
          else ;(globalThis.logger || console).warn(`[servermonitor] page ${idx + 1} rendered empty`)
        } catch (err) {
          ;(globalThis.logger || console).warn(`[servermonitor] render page ${idx + 1} failed`, err)
        }
      }
    }

    if (!segs.length) return this.reply(await buildTextFallback(entries))
    if (segs.length < pages.length) {
      ;(globalThis.logger || console).warn(`[servermonitor] partial render: ${segs.length}/${pages.length}`)
    }
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
        const data = await buildStatusData([entry], 1, 1, [entry], config)
        data.summary = `服务器【${entry.name}】详情`
        data.detail = true
        seg = await this.e.runtime.render(PLUGIN_NAME, "server_status", data, {
          retType: "base64",
          imgType: config.render?.imgType || "png",
          saveId: "servermonitor_detail",
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
    if (this.e.isGroup) return this.reply("为保护 token，请私聊我执行：#服务器状态待绑定")
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
      `#服务器状态帮助        查看本帮助`,
      `#服务器状态检查        查看插件加载和配置`,
      `#服务器状态添加 <名称> [上报地址] [备注]  主人私聊添加（地址需带 http://）`,
      `#服务器状态命令 <名称>  主人私聊重新获取 token 与启动命令`,
      `#服务器状态绑定 <token> 或 <名称> <token>  主人私聊绑定`,
      `#服务器状态待绑定      主人私聊查看待绑定 token`,
      `#服务器状态改名 <旧名> <新名>  主人私聊修改名称`,
      `#删除服务器 <名称|序号> 主人删除（无参数列出服务器）`,
      `#确认删除服务器 <序号>  主人二次确认删除`,
      `#服务器状态插件更新    主人更新插件代码`,
      `#服务器状态令牌        共享 token 已停用（迁移说明）`,
    ].join("\n"))
  }

  async usage() {
    return this.reply(usageHintFor(getMessageText(this.e)))
  }

  async check() {
    if (!(await this._isAdmin())) return this._replyNoPermission()
    const routeReady = initServerMonitorRoutes()
    const config = await loadConfig()
    const entries = await getEntries().catch(() => [])
    const pendingItems = await listPendingTokens().catch(() => [])
    const badTokenCount = (config.servers || []).filter(item => !/^sm_[0-9a-f]{32}$/.test(String(item.token || ""))).length
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
      `待绑定token：${pendingItems.length} 个`,
      `token格式：${badTokenCount ? `${badTokenCount} 台不符合 sm_+32位hex（建议重新登记）` : "全部规范"}`,
      `当前展示：${entries.map(i => i.name).join("、") || "空"}`,
      `public_status：${config.public_status ? "true" : "false"}`,
      `include_local：${config.include_local ? "true" : "false"}`,
      `shared_token：已停用${config.shared_token ? "（旧配置仍存在，仅用于识别）" : ""}`,
      `runtime.render：${this.e?.runtime?.render ? "可用" : "未检测到"}`,
    ].join("\n"))
  }

  async token() {
    if (this.e.isGroup) return this.reply("为保护 token，请私聊我执行：#服务器状态令牌")
    return this.reply([
      "【servermonitor】共享 token 已停用",
      "共享 token 无法区分具体主机，已被一机一 token 取代。",
      "如果已有服务器之前用共享 token 自动注册过，可直接执行：",
      "#服务器状态命令 <名称>",
      "获取该服务器已有的独立 token 和 agent 启动命令。",
      "新服务器请在服务器侧生成 token，再执行 #服务器状态绑定 <token>，或使用 #服务器状态添加 <名称> <上报地址>。",
    ].join("\n"))
  }

  async command() {
    const text = getMessageText(this.e)
    const args = parseCommandArg(text, /^#?服务器状态命令\s+(\S{1,32})$/)
    const name = args?.[0]?.trim()
    if (!name) return false
    if (this.e.isGroup) return this.reply("为保护 token，请私聊我执行此命令")
    try {
      const info = await buildServerCommand(name, { configuredUrl: cfg?.server?.url || "" })
      return this.reply(buildServerCommandReply(info))
    } catch (err) {
      return this.reply(`获取命令失败：${err.message || err}`)
    }
  }

  async add() {
    const text = getMessageText(this.e)
    const args = parseCommandArg(text, /^#?服务器状态添加\s+(\S{1,32})(?:\s+(.+))?$/)
    const name = args?.[0]?.trim()
    const { requestedAddress, note } = parseAddServerExtra(args?.[1])
    if (!name) return false
    if (this.e.isGroup) {
      return this.reply("为保护 token，请私聊我执行此命令")
    }
    if (!requestedAddress && looksLikeAddressWithoutScheme(note)) {
      return this.reply([
        "上报地址看起来缺少协议前缀：",
        note,
        "",
        "请重发（地址必须以 http:// 或 https:// 开头）：",
        `#服务器状态添加 ${name} http://${note} [备注]`,
      ].join("\n"))
    }

    try {
      const configuredAddress = String(cfg?.server?.url || "http://127.0.0.1:2536")
      const reportUrl = normalizeReportUrl(requestedAddress || configuredAddress)
      const warning = isLoopbackReportUrl(reportUrl)
        ? "警告：当前上报地址是回环地址，远程 agent 无法访问；请重新添加并填写公网/内网地址。"
        : ""
      const item = await addServer(name, note, reportUrl)
      const command = makeAgentCommand({
        reportUrl,
        name: item.name,
        token: item.token,
        interval: 10,
      })
      return this.reply(buildAddServerReply({
        name: item.name,
        note: item.note,
        token: item.token,
        reportUrl,
        command,
        warning,
      }))
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
      const configuredAddress = normalizeReportUrl(cfg?.server?.url || "http://127.0.0.1:2536")
      const item = name
        ? await bindServerToken(name, token, note, configuredAddress)
        : await bindServerToken(token, "", "设备侧生成 token", configuredAddress)
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

  async _removeByName(name) {
    const cleanName = String(name || "").trim()
    if (!cleanName) return false
    try {
      await removeServer(cleanName)
      return this.reply(`已删除服务器【${cleanName}】`)
    } catch (err) {
      return this.reply(`删除失败：${err.message || err}`)
    }
  }

  async del() {
    const args = parseCommandArg(getMessageText(this.e), /^#?服务器状态删除\s+(\S{1,32})$/)
    return this._removeByName(args?.[0])
  }

  async deleteTarget() {
    const parsed = parseDeleteTarget(getMessageText(this.e))
    if (!parsed) return false
    if (parsed.isIndex) return this.deleteByIndex()
    return this._removeByName(parsed.target)
  }

  async deleteByIndex() {
    const text = getMessageText(this.e)
    const args = parseCommandArg(text, /^#?删除服务器\s*[+＋]?\s*(\d+)?$/)
    const config = await loadConfig()

    if (!args?.[0]) {
      return this.reply(await listServersText())
    }

    const index = Number(args[0])
    const servers = sortedServers(config)
    const item = servers[index - 1]
    if (!item) return this.reply(`未找到序号 ${index} 对应的服务器`)

    const userId = String(this.e.user_id || "")
    deleteConfirmations.set(userId, {
      name: item.name,
      index,
      expireAt: Date.now() + DELETE_CONFIRM_TTL,
    })

    return this.reply([
      `即将删除服务器【${item.name}】`,
      `请在 5 分钟内发送：#确认删除服务器 ${index}`,
    ].join("\n"))
  }

  async confirmDelete() {
    const text = getMessageText(this.e)
    const args = parseCommandArg(text, /^#?确认删除服务器\s*[+＋]?\s*(\d+)?$/)
    const userId = String(this.e.user_id || "")
    const pending = deleteConfirmations.get(userId)

    if (!pending || Date.now() > pending.expireAt) {
      deleteConfirmations.delete(userId)
      return this.reply("没有待确认的删除操作，请先发送：#删除服务器 <名称|序号>")
    }

    if (args?.[0] && Number(args[0]) !== pending.index) {
      return this.reply(`序号不一致，请发送：#确认删除服务器 ${pending.index}`)
    }

    try {
      await removeServer(pending.name)
      deleteConfirmations.delete(userId)
      return this.reply(`已删除服务器【${pending.name}】`)
    } catch (err) {
      return this.reply(`删除失败：${err.message || err}`)
    }
  }

  async updatePlugin() {
    const upstream = "https://github.com/qsbb/servermonitor.git"
    try {
      const { stdout } = await execFileAsync("git", ["pull", "--ff-only", upstream, "main"], {
        cwd: ROOT_DIR,
        timeout: 60_000,
      })
      const output = String(stdout || "").trim()
      return this.reply([
        `【${PLUGIN_NAME}】插件更新完成`,
        output || "已是最新版本",
      ].join("\n"))
    } catch (err) {
      const detail = String(err?.stderr || err?.message || err).trim()
      return this.reply([
        `插件更新失败：${detail || "未知错误"}`,
        `可尝试在插件目录执行：git remote set-url origin ${upstream}`,
      ].join("\n"))
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
