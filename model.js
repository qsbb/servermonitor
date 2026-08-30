import fs from "node:fs/promises"
import os from "node:os"
import { collectLocalSnapshot } from "./local.js"
import { DATA_DIR, SNAPSHOT_FILE, loadConfig, updateConfig, makeToken, ensureConfigExists } from "./config.js"

const STATE_KEY = "__servermonitor_state__"
const state = globalThis[STATE_KEY] ??= {
  config: null,
  configIndexByName: new Map(),
  configIndexByToken: new Map(),
  records: new Map(),
  bootstrapped: false,
  persistedLoaded: false,
  lastPersistAt: 0,
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value)
}

function numOrNull(value) {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function strOrNull(value) {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s ? s : null
}

function clampPercent(value) {
  const n = numOrNull(value)
  if (n === null) return null
  return Math.max(0, Math.min(100, n))
}

function buildIndexes(config) {
  state.configIndexByName.clear()
  state.configIndexByToken.clear()
  for (const item of config.servers || []) {
    state.configIndexByName.set(item.name, item)
    state.configIndexByToken.set(item.token, item)
  }
}

async function hydrateConfig() {
  await ensureConfigExists()
  const config = await loadConfig()
  state.config = config
  buildIndexes(config)
  return config
}

async function hydratePersisted() {
  if (state.persistedLoaded) return
  state.persistedLoaded = true
  try {
    const raw = await fs.readFile(SNAPSHOT_FILE, "utf8")
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed?.servers)) {
      for (const item of parsed.servers) {
        if (!item?.name) continue
        state.records.set(String(item.name), {
          snap: item.snap ?? null,
          lastSeen: Number(item.lastSeen) || 0,
          state: item.state || "pending",
          alertedAt: Number(item.alertedAt) || 0,
          updatedAt: Number(item.updatedAt) || 0,
        })
      }
    }
  } catch {}
}

async function bootstrap() {
  if (state.bootstrapped) return
  state.bootstrapped = true
  await hydratePersisted()
  await hydrateConfig()
}

async function refreshConfig() {
  const config = await hydrateConfig()
  return config
}

function ensureRecord(name) {
  const key = String(name)
  if (!state.records.has(key)) {
    state.records.set(key, {
      snap: null,
      lastSeen: 0,
      state: "pending",
      alertedAt: 0,
      updatedAt: 0,
    })
  }
  return state.records.get(key)
}

function resolveRecord(name) {
  return state.records.get(String(name)) ?? null
}

function resolveConfigServer(name) {
  return state.configIndexByName.get(String(name)) ?? null
}

function resolveConfigByToken(token) {
  return state.configIndexByToken.get(String(token)) ?? null
}

function sanitizeSnapshot(body) {
  const os = body.os && typeof body.os === "object" ? body.os : {}
  const cpu = body.cpu && typeof body.cpu === "object" ? body.cpu : {}
  const mem = body.mem && typeof body.mem === "object" ? body.mem : {}
  const net = body.net && typeof body.net === "object" ? body.net : {}
  const disks = Array.isArray(body.disks)
    ? body.disks
        .map(item => {
          if (!item || typeof item !== "object") return null
          return {
            mount: strOrNull(item.mount),
            used: numOrNull(item.used),
            total: numOrNull(item.total),
          }
        })
        .filter(Boolean)
    : []
  const gpus = Array.isArray(body.gpus)
    ? body.gpus
        .map(item => {
          if (!item || typeof item !== "object") return null
          return {
            model: strOrNull(item.model),
            usage: clampPercent(item.usage),
            temp: numOrNull(item.temp),
            memUsed: numOrNull(item.memUsed),
            memTotal: numOrNull(item.memTotal),
            power: numOrNull(item.power),
          }
        })
        .filter(Boolean)
    : null

  return {
    v: 1,
    name: strOrNull(body.name) || "",
    agent_ts: numOrNull(body.agent_ts) || Date.now(),
    os: {
      platform: strOrNull(os.platform),
      distro: strOrNull(os.distro),
      release: strOrNull(os.release),
      arch: strOrNull(os.arch),
      hostname: strOrNull(os.hostname),
      uptime: numOrNull(os.uptime),
    },
    cpu: {
      model: strOrNull(cpu.model),
      cores: numOrNull(cpu.cores),
      usage: clampPercent(cpu.usage),
      temp: numOrNull(cpu.temp),
      power: numOrNull(cpu.power),
    },
    gpus,
    mem: {
      used: numOrNull(mem.used),
      total: numOrNull(mem.total),
      swapUsed: numOrNull(mem.swapUsed),
      swapTotal: numOrNull(mem.swapTotal),
    },
    net: {
      iface: strOrNull(net.iface),
      rxSec: numOrNull(net.rxSec),
      txSec: numOrNull(net.txSec),
      rxTotal: numOrNull(net.rxTotal),
      txTotal: numOrNull(net.txTotal),
    },
    disks,
    load: Array.isArray(body.load) ? body.load.map(numOrNull).slice(0, 3) : null,
  }
}

function updateRecordFromSnapshot(serverName, snap, receivedAt = Date.now()) {
  const record = ensureRecord(serverName)
  record.snap = snap
  record.lastSeen = receivedAt
  record.updatedAt = receivedAt
  record.state = "online"
  return record
}

function buildBasicLocalSnapshot() {
  const totalMem = os.totalmem()
  return {
    v: 1,
    name: os.hostname(),
    agent_ts: Date.now(),
    os: {
      platform: os.platform(),
      distro: null,
      release: os.release(),
      arch: os.arch(),
      hostname: os.hostname(),
      uptime: os.uptime(),
    },
    cpu: {
      model: os.cpus()?.[0]?.model || null,
      cores: os.cpus().length,
      usage: null,
      temp: null,
      power: null,
    },
    gpus: [],
    mem: {
      used: +((totalMem - os.freemem()) / 1024 ** 3).toFixed(1),
      total: +(totalMem / 1024 ** 3).toFixed(1),
      swapUsed: null,
      swapTotal: null,
    },
    net: null,
    disks: [],
    load: process.platform === "win32" ? null : os.loadavg().slice(0, 3).map(i => +Number(i).toFixed(2)),
  }
}

function isLocalName(name) {
  const value = String(name || "").trim().toLowerCase()
  const host = os.hostname().toLowerCase()
  return ["本机", "local", "localhost"].includes(value) || value === host
}

async function buildLocalEntry(timeoutMs = 30000, now = Date.now()) {
  let raw
  try {
    raw = await collectLocalSnapshot()
  } catch {
    raw = buildBasicLocalSnapshot()
  }
  const snap = sanitizeSnapshot(raw || buildBasicLocalSnapshot())
  const host = snap.os?.hostname || snap.name || os.hostname()
  const conf = {
    name: "本机",
    note: host && host !== "本机" ? host : "Yunzai 所在主机",
  }
  const record = {
    snap,
    lastSeen: now,
    updatedAt: now,
    state: "online",
    alertedAt: 0,
  }
  return decorateEntry(conf, record, now, timeoutMs)
}

function formatDuration(seconds) {
  const value = numOrNull(seconds)
  if (value === null || value < 0) return "—"
  let remain = Math.floor(value)
  const days = Math.floor(remain / 86400)
  remain %= 86400
  const hours = Math.floor(remain / 3600)
  remain %= 3600
  const minutes = Math.floor(remain / 60)
  const secs = remain % 60
  const parts = []
  if (days) parts.push(`${days}天`)
  if (hours) parts.push(`${hours}小时`)
  if (!days && minutes) parts.push(`${minutes}分`)
  if (!days && !hours && !minutes && secs !== undefined) parts.push(`${secs}秒`)
  return parts.join("") || "0秒"
}

function formatAgo(ms) {
  const value = numOrNull(ms)
  if (value === null || value < 0) return "—"
  const seconds = Math.floor(value / 1000)
  if (seconds < 60) return `${seconds}秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  return `${days}天前`
}

function formatPercent(value, digits = 1) {
  if (value === null || value === undefined || value === "") return "—"
  const n = Number(value)
  if (!Number.isFinite(n)) return "—"
  return `${n.toFixed(digits)}%`
}

function formatSizeGB(value, digits = 1) {
  if (value === null || value === undefined || value === "") return "—"
  const n = Number(value)
  if (!Number.isFinite(n)) return "—"
  return `${n.toFixed(digits)}GB`
}

function formatRateMB(value, digits = 2) {
  if (value === null || value === undefined || value === "") return "—"
  const n = Number(value)
  if (!Number.isFinite(n)) return "—"
  return `${n.toFixed(digits)}MB/s`
}

function formatTemp(value) {
  if (value === null || value === undefined || value === "") return "—"
  const n = Number(value)
  if (!Number.isFinite(n)) return "—"
  return `${Math.round(n)}℃`
}

function formatPower(value) {
  if (value === null || value === undefined || value === "") return "—"
  const n = Number(value)
  if (!Number.isFinite(n)) return "—"
  return `${n.toFixed(1)}W`
}

function formatLoad(load) {
  if (!Array.isArray(load) || !load.length) return "—"
  return load.filter(i => Number.isFinite(i)).map(i => i.toFixed(2)).join(" / ") || "—"
}

function severityColor(score) {
  if (!Number.isFinite(score)) return "#64748b"
  if (score >= 90) return "#f87171"
  if (score >= 70) return "#fbbf24"
  return "#22c55e"
}

function stateColor(state) {
  if (state === "online") return "#22c55e"
  if (state === "offline") return "#f87171"
  return "#94a3b8"
}

function normalizeLineText(lines, limit = 2) {
  const list = Array.isArray(lines) ? lines.filter(Boolean) : []
  if (!list.length) return "—"
  if (list.length <= limit) return list.join(" ｜ ")
  return `${list.slice(0, limit).join(" ｜ ")} ｜ +${list.length - limit}`
}

function formatDiskText(disks) {
  if (!Array.isArray(disks) || !disks.length) return "—"
  const lines = disks
    .map(item => {
      const used = formatSizeGB(item.used)
      const total = formatSizeGB(item.total)
      const pct = item.used !== null && item.total !== null ? formatPercent((Number(item.used) / Number(item.total)) * 100) : "—"
      const mount = item.mount || "?"
      return `${mount} ${used}/${total} ${pct}`
    })
  return normalizeLineText(lines, 2)
}

function formatGpuText(gpu) {
  const parts = []
  if (gpu.usage !== null && gpu.usage !== undefined) parts.push(formatPercent(gpu.usage))
  parts.push(`温度 ${formatTemp(gpu.temp)}`)
  if (gpu.memUsed !== null || gpu.memTotal !== null) {
    parts.push(`显存 ${formatSizeGB(gpu.memUsed)}/${formatSizeGB(gpu.memTotal)}`)
  }
  parts.push(`功耗 ${formatPower(gpu.power)}`)
  return parts.join(" · ")
}

function maxPercent(values) {
  const nums = values.filter(v => Number.isFinite(v)).map(v => Math.max(0, Math.min(100, Number(v))))
  if (!nums.length) return null
  return Math.max(...nums)
}

function computeUsagePercent(used, total) {
  const u = Number(used)
  const t = Number(total)
  if (!Number.isFinite(u) || !Number.isFinite(t) || t <= 0) return null
  return Math.max(0, Math.min(100, (u / t) * 100))
}

function computeState(record, timeoutMs, now = Date.now()) {
  if (!record || !record.snap) return "pending"
  const age = now - (record.lastSeen || 0)
  return age <= timeoutMs ? "online" : "offline"
}

function computeSeverity(record, timeoutMs, now = Date.now()) {
  const state = computeState(record, timeoutMs, now)
  if (state !== "online") return state === "offline" ? 100 : 50
  const snap = record.snap
  const cpu = numOrNull(snap?.cpu?.usage)
  const mem = computeUsagePercent(snap?.mem?.used, snap?.mem?.total)
  const disk = Array.isArray(snap?.disks) ? maxPercent(snap.disks.map(d => computeUsagePercent(d.used, d.total)).filter(v => v !== null)) : null
  const gpu = Array.isArray(snap?.gpus) ? maxPercent(snap.gpus.map(g => numOrNull(g.usage)).filter(v => v !== null)) : null
  return Math.max(cpu ?? 0, mem ?? 0, disk ?? 0, gpu ?? 0)
}

function buildGpuView(snap) {
  if (snap.gpus === null) {
    return {
      hasGpu: false,
      gpuEmptyText: "GPU 数据采集失败",
      gpus: [],
    }
  }
  if (!Array.isArray(snap.gpus) || !snap.gpus.length) {
    return {
      hasGpu: false,
      gpuEmptyText: "无独立显卡",
      gpus: [],
    }
  }
  const gpus = snap.gpus.map(gpu => {
    const usage = clampPercent(gpu.usage)
    return {
      model: gpu.model || "未知 GPU",
      pct: usage ?? 0,
      color: severityColor(usage ?? 0),
      text: formatGpuText(gpu),
    }
  })
  return {
    hasGpu: true,
    gpuEmptyText: "无独立显卡",
    gpus,
  }
}

export function decorateEntry(conf, record, now = Date.now(), timeoutMs = 30000) {
  const snap = record?.snap ?? null
  const state = computeState(record, timeoutMs, now)
  const severity = computeSeverity(record, timeoutMs, now)
  const ageMs = record?.lastSeen ? now - record.lastSeen : null

  const cpuUsage = clampPercent(snap?.cpu?.usage)
  const cpuText = snap
    ? [
        `占用 ${formatPercent(cpuUsage)}`,
        `温度 ${formatTemp(snap.cpu?.temp)}`,
        `功耗 ${formatPower(snap.cpu?.power)}`,
      ].join(" · ")
    : "—"

  const memUsed = numOrNull(snap?.mem?.used)
  const memTotal = numOrNull(snap?.mem?.total)
  const memPct = computeUsagePercent(memUsed, memTotal)
  const memText = snap
    ? `${formatSizeGB(memUsed)} / ${formatSizeGB(memTotal)}${memPct === null ? "" : ` (${formatPercent(memPct)})`}`
    : "—"

  const netText = snap
    ? `${formatRateMB(snap.net?.rxSec)} ↓ / ${formatRateMB(snap.net?.txSec)} ↑ · 累计 ${formatSizeGB(snap.net?.rxTotal)} ↓ / ${formatSizeGB(snap.net?.txTotal)} ↑`
    : "—"

  const powerParts = []
  if (snap?.cpu?.power !== null && snap?.cpu?.power !== undefined) powerParts.push(`CPU ${formatPower(snap.cpu.power)}`)
  const gpuPower = Array.isArray(snap?.gpus)
    ? snap.gpus.map(g => numOrNull(g.power)).filter(v => v !== null)
    : []
  if (gpuPower.length) {
    const sum = gpuPower.reduce((a, b) => a + Number(b || 0), 0)
    powerParts.push(`GPU ${formatPower(sum)}`)
  }
  const powerText = powerParts.length ? powerParts.join(" · ") : "—"

  const diskText = snap ? formatDiskText(snap.disks) : "—"
  const gpuView = snap ? buildGpuView(snap) : { hasGpu: false, gpuEmptyText: "—", gpus: [] }
  const osText = snap
    ? `${snap.os?.distro || snap.os?.platform || "未知系统"} · ${snap.os?.release || snap.os?.arch || ""}`.trim()
    : "—"

  const loadText = snap ? formatLoad(snap.load) : "—"
  const uptimeText = snap ? formatDuration(snap.os?.uptime) : "—"
  const dataAgeText = ageMs === null ? "从未上报" : formatAgo(ageMs)
  const lastSeenText = record?.lastSeen ? new Date(record.lastSeen).toLocaleString() : "—"
  const noteText = conf.note || ""
  const name = conf.name
  const stateText = state === "online" ? "在线" : state === "offline" ? "离线" : "未上报"

  const borderColor = state === "online"
    ? severityColor(severity)
    : state === "offline"
      ? "#ef4444"
      : "#64748b"

  return {
    name,
    noteText,
    state,
    stateText,
    stateColor: stateColor(state),
    borderColor,
    osText,
    uptimeText,
    dataAgeText,
    lastSeenText,
    cpuModel: snap?.cpu?.model || "未知 CPU",
    cpuPct: cpuUsage ?? 0,
    cpuColor: severityColor(cpuUsage ?? 0),
    cpuText,
    memText,
    diskText,
    netText,
    powerText,
    loadText,
    hasGpu: gpuView.hasGpu,
    gpuEmptyText: gpuView.gpuEmptyText,
    gpus: gpuView.gpus,
    rank: state === "online" ? severity : state === "offline" ? 1000 : 900,
  }
}

export async function getEntries() {
  await bootstrap()
  const config = await refreshConfig()
  const timeoutMs = config.offline_timeout * 1000
  const now = Date.now()
  const registered = config.servers.map(conf => decorateEntry(conf, state.records.get(conf.name) ?? null, now, timeoutMs))
  if (!config.include_local) return registered
  const hasLocalRegistered = config.servers.some(conf => isLocalName(conf.name))
  const local = hasLocalRegistered ? [] : [await buildLocalEntry(timeoutMs, now)]
  return [...local, ...registered]
}

export async function getEntryByName(name) {
  await bootstrap()
  const config = await refreshConfig()
  const timeoutMs = config.offline_timeout * 1000
  const now = Date.now()
  const conf = resolveConfigServer(name)
  if (!conf) return isLocalName(name) ? await buildLocalEntry(timeoutMs, now) : null
  return decorateEntry(conf, state.records.get(conf.name) ?? null, now, timeoutMs)
}

export async function buildStatusData(entries, pageNum = 1, pageCount = 1, allEntries = null) {
  await bootstrap()
  const config = await refreshConfig()
  const list = Array.isArray(entries) ? entries : []
  const scope = Array.isArray(allEntries) && allEntries.length ? allEntries : list
  const online = scope.filter(i => i.state === "online").length
  const offline = scope.filter(i => i.state === "offline").length
  const pending = scope.filter(i => i.state === "pending").length
  const busiest = scope.filter(i => i.state === "online").sort((a, b) => (b.cpuPct ?? 0) - (a.cpuPct ?? 0))[0]
  const summary = [
    `共 ${scope.length} 台`,
    `${online} 在线`,
    `${offline} 离线`,
    pending ? `${pending} 未上报` : null,
    busiest ? `最忙 ${busiest.name} CPU ${formatPercent(busiest.cpuPct)}` : null,
  ].filter(Boolean).join(" · ")

  return {
    summary,
    servers: list,
    pageNum,
    pageCount,
    detail: false,
    updateTime: new Date().toLocaleString(),
    pageSize: config.page_size,
    imgType: config.render?.imgType || "png",
  }
}

export async function buildTextFallback(entries) {
  const list = Array.isArray(entries) ? entries : []
  const lines = []
  lines.push(`共 ${list.length} 台服务器`)
  for (const item of list) {
    const status = item.state === "online" ? "在线" : item.state === "offline" ? `离线(${item.dataAgeText})` : "未上报"
    lines.push(`${item.name} · ${status} · CPU ${formatPercent(item.cpuPct)} · 内存 ${item.memText} · 网速 ${item.netText}`)
  }
  return lines.join("\n")
}

export async function listServersText() {
  await bootstrap()
  const config = await refreshConfig()
  const timeoutMs = config.offline_timeout * 1000
  const now = Date.now()
  const entries = config.servers.map(conf => decorateEntry(conf, state.records.get(conf.name) ?? null, now, timeoutMs))
  if (!entries.length) return "尚未注册服务器；发送 #服务器状态 将显示本机状态。"

  const lines = []
  lines.push(`已注册 ${entries.length} 台服务器`)
  for (const item of entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))) {
    lines.push(`${item.name} · ${item.stateText} · ${item.dataAgeText}${item.noteText ? ` · ${item.noteText}` : ""}`)
  }
  return lines.join("\n")
}

export async function addServer(name, note = "") {
  const cleanName = String(name || "").trim()
  if (!cleanName) throw new Error("服务器名不能为空")
  const cleanNote = String(note || "").trim()
  const config = await updateConfig(current => {
    if (current.servers.some(item => item.name === cleanName)) throw new Error(`服务器【${cleanName}】已存在`)
    current.servers.push({
      name: cleanName,
      token: makeToken(),
      note: cleanNote,
      createdAt: Date.now(),
    })
    return current
  })
  await refreshConfig()
  ensureRecord(cleanName)
  return config.servers.find(item => item.name === cleanName)
}

export async function removeServer(name) {
  const cleanName = String(name || "").trim()
  if (!cleanName) throw new Error("服务器名不能为空")
  const config = await updateConfig(current => {
    const before = current.servers.length
    current.servers = current.servers.filter(item => item.name !== cleanName)
    if (current.servers.length === before) throw new Error(`未找到服务器【${cleanName}】`)
    return current
  })
  state.records.delete(cleanName)
  await refreshConfig()
  return config
}

export async function handleReport(req, res) {
  try {
    await bootstrap()
    await refreshConfig()
    const token = String(req.get("X-SM-Token") || "").trim()
    const server = resolveConfigByToken(token)
    if (!server) return res.status(401).json({ ok: false, msg: "token invalid" })
    const body = req.body
    if (!body || typeof body !== "object" || body.v !== 1) {
      return res.status(422).json({ ok: false, msg: "bad schema" })
    }
    const snap = sanitizeSnapshot(body)
    snap.name = server.name
    updateRecordFromSnapshot(server.name, snap, Date.now())
    return res.json({ ok: true })
  } catch (err) {
    ;(globalThis.logger || console).error("[servermonitor] report failed", err)
    return res.status(500).json({ ok: false, msg: "internal error" })
  }
}

export async function scanOffline() {
  await bootstrap()
  const config = await refreshConfig()
  const timeoutMs = config.offline_timeout * 1000
  const now = Date.now()
  const alerts = []

  for (const conf of config.servers) {
    const record = ensureRecord(conf.name)
    const prevState = record.state || (record.snap ? "online" : "pending")
    const nextState = computeState(record, timeoutMs, now)
    record.state = nextState
    if (prevState === nextState) continue

    const isCooldownReady = now - (record.alertedAt || 0) >= (config.alert?.cooldown || 120) * 1000
    const isInteresting = (prevState === "online" && nextState === "offline") || (prevState === "offline" && nextState === "online")
    if (config.alert?.enabled && isCooldownReady && isInteresting) {
      record.alertedAt = now
      alerts.push({ name: conf.name, from: prevState, to: nextState })
    }
  }

  if (alerts.length && globalThis.Bot?.sendMasterMsg) {
    const msg = alerts
      .map(item => item.to === "offline"
        ? `⚠️ 服务器【${item.name}】已离线`
        : `✅ 服务器【${item.name}】已恢复在线`)
      .join("\n")
    try {
      await Bot.sendMasterMsg(msg)
    } catch (err) {
      ;(globalThis.logger || console).warn("[servermonitor] sendMasterMsg failed", err)
    }
  }

  return alerts
}

export async function persist() {
  await bootstrap()
  await fs.mkdir(DATA_DIR, { recursive: true })
  const config = await refreshConfig()
  const payload = {
    v: 1,
    savedAt: Date.now(),
    servers: config.servers.map(conf => {
      const record = state.records.get(conf.name)
      return {
        name: conf.name,
        lastSeen: record?.lastSeen || 0,
        state: record?.state || (record?.snap ? "online" : "pending"),
        alertedAt: record?.alertedAt || 0,
        updatedAt: record?.updatedAt || 0,
        snap: record?.snap || null,
      }
    }),
  }
  await fs.writeFile(SNAPSHOT_FILE, JSON.stringify(payload, null, 2), "utf8")
  state.lastPersistAt = Date.now()
  return payload
}

export async function loadPersistedSnapshotFile() {
  await hydratePersisted()
  return clone({
    servers: [...state.records.entries()].map(([name, value]) => ({
      name,
      lastSeen: value.lastSeen,
      state: value.state,
      alertedAt: value.alertedAt,
      updatedAt: value.updatedAt,
      snap: value.snap,
    })),
  })
}

export function makeAgentCommand({ baseUrl, name, token, interval = 10, path = "/servermonitor/report" }) {
  const url = String(baseUrl || "").replace(/\/+$/, "") + path
  return [
    `node agent.mjs --name ${JSON.stringify(String(name))} --token ${JSON.stringify(String(token))} --report-url ${JSON.stringify(url)} --interval ${JSON.stringify(String(interval))}`,
  ].join(" ")
}

export function sortEntries(entries) {
  return [...(entries || [])].sort((a, b) => {
    if (a.state !== b.state) {
      const weight = { offline: 0, pending: 1, online: 2 }
      return (weight[a.state] ?? 9) - (weight[b.state] ?? 9)
    }
    const diff = (b.cpuPct ?? 0) - (a.cpuPct ?? 0)
    if (diff) return diff
    return a.name.localeCompare(b.name, "zh-CN")
  })
}

export {
  state,
  formatDuration,
  formatAgo,
  formatPercent,
  formatSizeGB,
  formatRateMB,
  formatTemp,
  formatPower,
  formatLoad,
  stateColor,
  severityColor,
}
