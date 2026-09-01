import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { collectLocalSnapshot } from "./local.js"
import { DATA_DIR, SNAPSHOT_FILE, PENDING_FILE, loadConfig, updateConfig, makeToken, ensureConfigExists } from "./config.js"

const STATE_KEY = "__servermonitor_state__"
const state = globalThis[STATE_KEY] ??= {
  config: null,
  configIndexByName: new Map(),
  configIndexByToken: new Map(),
  records: new Map(),
  pendingReports: new Map(),
  bootstrapped: false,
  persistedLoaded: false,
  lastPersistAt: 0,
  pendingPersistAt: 0,
  reportRate: new Map(),
}
const MAX_SERVERS = 64
const MAX_PENDING_WRITE_MS = 30_000
const MAX_PENDING_ENTRIES = 100
const MAX_REPORTS_PER_MIN = 60
const MAX_REPORTS_PER_IP_MIN = 240

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

function timingSafeEqualStrings(a, b) {
  const left = crypto.createHash("sha256").update(String(a ?? "")).digest()
  const right = crypto.createHash("sha256").update(String(b ?? "")).digest()
  return crypto.timingSafeEqual(left, right)
}

function clientIp(req) {
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim()
  return forwarded || req?.ip || req?.socket?.remoteAddress || "unknown"
}

function rateLimit(key, limit, windowMs = 60_000) {
  const now = Date.now()
  const item = state.reportRate.get(key)
  if (!item || now > item.resetAt) {
    state.reportRate.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (item.count >= limit) return false
  item.count += 1
  return true
}

function allowReport(req, token) {
  const ip = clientIp(req)
  if (!rateLimit(`ip:${ip}`, MAX_REPORTS_PER_IP_MIN)) return false
  if (!rateLimit(`token:${token || ""}:${ip}`, MAX_REPORTS_PER_MIN)) return false
  return true
}

function strOrNull(value, max = 128) {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s ? s.slice(0, max) : null
}

function clampPercent(value) {
  const n = numOrNull(value)
  if (n === null) return null
  return Math.max(0, Math.min(100, n))
}

function clampNonNegative(value, max = Number.MAX_SAFE_INTEGER) {
  const n = numOrNull(value)
  if (n === null || n < 0) return null
  return Math.min(n, max)
}

function clampTemp(value) {
  const n = numOrNull(value)
  if (n === null || n < -20 || n > 150) return null
  return n
}

function clampPower(value) {
  const n = numOrNull(value)
  if (n === null || n < 0 || n > 10000) return null
  return n
}

async function atomicWriteJson(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8")
  await fs.rename(tmp, file)
}

function isEmptySnapshot(snap) {
  if (!snap || typeof snap !== "object") return true
  const hasCpu = snap.cpu?.usage !== null || snap.cpu?.cores !== null || snap.cpu?.model !== null
  const hasMem = snap.mem?.total !== null || snap.mem?.used !== null
  const hasDisk = Array.isArray(snap.disks) && snap.disks.length > 0
  const hasGpu = Array.isArray(snap.gpus) && snap.gpus.length > 0
  const hasOs = snap.os?.hostname !== null || snap.os?.platform !== null
  return !hasCpu && !hasMem && !hasDisk && !hasGpu && !hasOs
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

async function hydratePending() {
  const maxAgeMs = 24 * 60 * 60 * 1000
  const maxEntries = 100
  try {
    const stat = await fs.stat(PENDING_FILE).catch(() => null)
    if (stat && stat.size > 2 * 1024 * 1024) {
      ;(globalThis.logger || console).warn("[servermonitor] pending.json too large, skipped hydrate")
      return
    }
    const raw = await fs.readFile(PENDING_FILE, "utf8")
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed?.pending)) {
      const now = Date.now()
      const valid = parsed.pending
        .filter(item => item?.token && item?.name)
        .filter(item => now - (Number(item.lastSeen) || 0) <= maxAgeMs)
        .sort((a, b) => (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0))
        .slice(0, maxEntries)
      for (const item of valid) {
        state.pendingReports.set(String(item.token), {
          token: String(item.token),
          name: sanitizeServerName(item.name),
          snap: item.snap ?? null,
          lastSeen: Number(item.lastSeen) || Date.now(),
        })
      }
    }
  } catch {}
}

async function persistPending() {
  const maxAgeMs = 24 * 60 * 60 * 1000
  const maxEntries = 100
  const now = Date.now()
  const pending = [...state.pendingReports.values()]
    .filter(item => now - (item.lastSeen || 0) <= maxAgeMs)
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .slice(0, maxEntries)
  state.pendingReports = new Map(pending.map(item => [item.token, item]))
  const payload = { v: 1, savedAt: now, pending }
  await atomicWriteJson(PENDING_FILE, payload)
}

async function savePendingReport(token, snap, receivedAt = Date.now()) {
  const cleanToken = String(token || "").trim()
  const cleanName = sanitizeServerName(snap?.name || snap?.os?.hostname)
  if (!cleanToken || !cleanName) return null
  const prev = state.pendingReports.get(cleanToken)
  const item = { token: cleanToken, name: cleanName, snap, lastSeen: receivedAt }
  state.pendingReports.set(cleanToken, item)
  if (state.pendingReports.size > MAX_PENDING_ENTRIES) {
    const ordered = [...state.pendingReports.values()].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    for (const stale of ordered.slice(MAX_PENDING_ENTRIES)) state.pendingReports.delete(stale.token)
  }
  const shouldPersist = !prev
    || prev.name !== cleanName
    || receivedAt - (prev.lastSeen || 0) >= MAX_PENDING_WRITE_MS
    || Date.now() - state.pendingPersistAt >= MAX_PENDING_WRITE_MS
  if (shouldPersist) {
    await persistPending()
    state.pendingPersistAt = Date.now()
  }
  return item
}

async function bootstrap() {
  if (state.bootstrapped) return
  state.bootstrapped = true
  await hydratePersisted()
  await hydratePending()
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

function sanitizeServerName(value) {
  const raw = strOrNull(value) || ""
  return raw
    .replace(/[<>&"'`\\]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 32)
}

function sanitizeSnapshot(body) {
  const os = body.os && typeof body.os === "object" ? body.os : {}
  const cpu = body.cpu && typeof body.cpu === "object" ? body.cpu : {}
  const mem = body.mem && typeof body.mem === "object" ? body.mem : {}
  const net = body.net && typeof body.net === "object" ? body.net : {}
  const disks = Array.isArray(body.disks)
    ? body.disks
        .slice(0, 16)
        .map(item => {
          if (!item || typeof item !== "object") return null
          return {
            mount: strOrNull(item.mount, 128),
            used: clampNonNegative(item.used),
            total: clampNonNegative(item.total),
          }
        })
        .filter(item => item.mount && item.total !== null)
        .filter(item => item.used === null || item.used <= item.total)
    : []
  const gpus = Array.isArray(body.gpus)
    ? body.gpus
        .slice(0, 8)
        .map(item => {
          if (!item || typeof item !== "object") return null
          return {
            model: strOrNull(item.model, 128),
            usage: clampPercent(item.usage),
            temp: clampTemp(item.temp),
            memUsed: clampNonNegative(item.memUsed),
            memTotal: clampNonNegative(item.memTotal),
            power: clampPower(item.power),
          }
        })
        .filter(Boolean)
    : null

  const now = Date.now()
  let agentTs = numOrNull(body.agent_ts) || now
  if (agentTs > now + 5 * 60 * 1000 || agentTs < now - 365 * 24 * 60 * 60 * 1000) agentTs = now

  let memUsed = clampNonNegative(mem.used)
  const memTotal = clampNonNegative(mem.total)
  if (memUsed !== null && memTotal !== null && memUsed > memTotal) memUsed = memTotal

  let swapUsed = clampNonNegative(mem.swapUsed)
  const swapTotal = clampNonNegative(mem.swapTotal)
  if (swapUsed !== null && swapTotal !== null && swapUsed > swapTotal) swapUsed = swapTotal

  return {
    v: 1,
    name: strOrNull(body.name) || "",
    agent_ts: agentTs,
    os: {
      platform: strOrNull(os.platform),
      distro: strOrNull(os.distro),
      release: strOrNull(os.release),
      arch: strOrNull(os.arch),
      hostname: strOrNull(os.hostname),
      uptime: clampNonNegative(os.uptime),
    },
    cpu: {
      model: strOrNull(cpu.model),
      cores: clampNonNegative(cpu.cores, 4096),
      usage: clampPercent(cpu.usage),
      temp: clampTemp(cpu.temp),
      power: clampPower(cpu.power),
    },
    gpus,
    mem: {
      used: memUsed,
      total: memTotal,
      swapUsed,
      swapTotal,
    },
    net: {
      iface: strOrNull(net.iface),
      rxSec: clampNonNegative(net.rxSec, 1024 * 1024),
      txSec: clampNonNegative(net.txSec, 1024 * 1024),
      rxTotal: clampNonNegative(net.rxTotal),
      txTotal: clampNonNegative(net.txTotal),
    },
    disks,
    load: Array.isArray(body.load) ? body.load.map(value => clampNonNegative(value, 10000)).slice(0, 3) : null,
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
  if (minutes && (days || hours || !parts.length)) parts.push(`${minutes}分`)
  if (!parts.length) parts.push(`${secs}秒`)
  return parts.join("")
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
  return normalizeLineText(lines, 4)
}

function formatGpuText(gpu) {
  const parts = []
  if (gpu.temp !== null && gpu.temp !== undefined) parts.push(`温度 ${formatTemp(gpu.temp)}`)
  if (gpu.memUsed !== null || gpu.memTotal !== null) {
    parts.push(`显存 ${formatSizeGB(gpu.memUsed)}/${formatSizeGB(gpu.memTotal)}`)
  }
  if (gpu.power !== null && gpu.power !== undefined) parts.push(`功耗 ${formatPower(gpu.power)}`)
  return parts.join(" · ") || "—"
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
  if (snap.gpus === undefined) {
    return {
      hasGpu: false,
      gpuEmptyText: "GPU 数据采集失败",
      gpus: [],
    }
  }
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
      pct: usage,
      color: usage === null ? "#98a0b3" : severityColor(usage),
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
        snap.cpu?.temp !== null && snap.cpu?.temp !== undefined ? `温度 ${formatTemp(snap.cpu.temp)}` : null,
        snap.cpu?.power !== null && snap.cpu?.power !== undefined ? `功耗 ${formatPower(snap.cpu.power)}` : null,
      ].filter(Boolean).join(" · ") || "—"
    : "—"

  const memUsed = numOrNull(snap?.mem?.used)
  const memTotal = numOrNull(snap?.mem?.total)
  const memPct = computeUsagePercent(memUsed, memTotal)
  const memText = snap ? `${formatSizeGB(memUsed)} / ${formatSizeGB(memTotal)}` : "—"
  const swapText = snap
    ? `${formatSizeGB(numOrNull(snap.mem?.swapUsed))} / ${formatSizeGB(numOrNull(snap.mem?.swapTotal))}`
    : "—"
  const cpuCoresText = snap ? (numOrNull(snap.cpu?.cores) ?? "—") : "—"

  const netLines = snap
    ? [
        snap.net?.rxSec !== null && snap.net?.rxSec !== undefined ? `↓ ${formatRateMB(snap.net.rxSec)}` : null,
        snap.net?.txSec !== null && snap.net?.txSec !== undefined ? `↑ ${formatRateMB(snap.net.txSec)}` : null,
        snap.net?.rxTotal !== null && snap.net?.rxTotal !== undefined ? `累计 ↓ ${formatSizeGB(snap.net.rxTotal)}` : null,
        snap.net?.txTotal !== null && snap.net?.txTotal !== undefined ? `累计 ↑ ${formatSizeGB(snap.net.txTotal)}` : null,
      ].filter(Boolean)
    : []
  const netText = netLines.length ? netLines.join(" · ") : (snap ? "无网络数据" : "—")
  const netIfaceText = snap ? (snap.net?.iface || "—") : "—"

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
  const allDisks = snap && Array.isArray(snap.disks) ? snap.disks : []
  const diskOverflow = Math.max(0, allDisks.length - 8)
  const diskView = snap
    ? allDisks
        .map(d => {
          const pct = computeUsagePercent(d.used, d.total)
          const used = formatSizeGB(d.used)
          const total = formatSizeGB(d.total)
          return {
            mount: String(d.mount || "?"),
            pct: pct ?? 0,
            hasPct: pct !== null,
            color: severityColor(pct ?? 0),
            text: `${used}/${total}`,
            usedText: used,
            totalText: total,
          }
        })
        .sort((a, b) => b.pct - a.pct)
        .slice(0, 8)
    : []
  const gpuView = snap ? buildGpuView(snap) : { hasGpu: false, gpuEmptyText: "—", gpus: [] }
  const osText = snap
    ? `${snap.os?.distro || snap.os?.platform || "未知系统"} · ${snap.os?.release || snap.os?.arch || ""}`.trim()
    : "—"

  const loadText = snap ? formatLoad(snap.load) : "—"
  const uptimeText = snap ? formatDuration(snap.os?.uptime) : "—"
  const dataAgeText = ageMs === null ? "从未上报" : formatAgo(ageMs)
  const lastSeenText = record?.lastSeen
    ? new Date(record.lastSeen).toLocaleString("zh-CN", { hour12: false })
    : "—"
  const noteText = conf.note || ""
  const name = conf.name
  const stateText = state === "online" ? "在线" : state === "offline" ? "离线" : "未上报"
  const hasSnap = Boolean(snap)

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
    hasSnap,
    osText,
    uptimeText,
    dataAgeText,
    lastSeenText,
    cpuModel: snap?.cpu?.model || "未知 CPU",
    cpuPct: cpuUsage,
    cpuColor: cpuUsage === null ? "#98a0b3" : severityColor(cpuUsage),
    cpuText,
    cpuCoresText,
    memText,
    swapText,
    memPct,
    memColor: severityColor(memPct ?? 0),
    diskText,
    disks: diskView,
    diskOverflow,
    netText,
    netLines,
    netIfaceText,
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

export async function buildStatusData(entries, pageNum = 1, pageCount = 1, allEntries = null, config = null) {
  await bootstrap()
  if (!config) config = await refreshConfig()
  const list = Array.isArray(entries) ? entries : []
  const scope = Array.isArray(allEntries) && allEntries.length ? allEntries : list
  const online = scope.filter(i => i.state === "online").length
  const offline = scope.filter(i => i.state === "offline").length
  const pending = scope.filter(i => i.state === "pending").length
  const busiest = scope.filter(i => i.state === "online" && i.cpuPct !== null).sort((a, b) => (b.cpuPct ?? 0) - (a.cpuPct ?? 0))[0]
  const summary = [
    `共 ${scope.length} 台`,
    `${online} 在线`,
    `${offline} 离线`,
    pending ? `${pending} 未上报` : null,
    busiest ? `最忙 ${busiest.name} CPU ${formatPercent(busiest.cpuPct)}` : null,
  ].filter(Boolean).join(" · ")

  const totalEntries = Array.isArray(allEntries) && allEntries.length ? allEntries.length : list.length
  const useGrid = totalEntries >= 4
  return {
    summary,
    servers: list,
    pageNum,
    pageCount,
    detail: false,
    updateTime: new Date().toLocaleString("zh-CN", { hour12: false }),
    pageSize: config.page_size,
    imgType: config.render?.imgType || "png",
    layout: {
      cols: useGrid ? 2 : 1,
      mode: useGrid ? "grid" : "stack",
    },
  }
}

export async function buildTextFallback(entries) {
  const list = Array.isArray(entries) ? entries : []
  const lines = []
  lines.push(`共 ${list.length} 台服务器`)
  for (const item of list) {
    const status = item.state === "online" ? "在线" : item.state === "offline" ? `离线(${item.dataAgeText})` : "未上报"
    const cpuText = item.hasSnap ? formatPercent(item.cpuPct) : "—"
    lines.push(`${item.name} · ${status} · CPU ${cpuText} · 内存 ${item.memText} · 网速 ${item.netText}`)
  }
  return lines.join("\n")
}

export async function listPendingTokens() {
  await bootstrap()
  return [...state.pendingReports.values()]
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .map(item => ({
      name: item.name,
      token: item.token,
      tokenTail: String(item.token).slice(-6),
      ageSec: Math.max(0, Math.floor((Date.now() - (item.lastSeen || Date.now())) / 1000)),
    }))
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
  entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
  entries.forEach((item, idx) => {
    lines.push(`${idx + 1}. ${item.name} · ${item.stateText} · ${item.dataAgeText}${item.noteText ? ` · ${item.noteText}` : ""}`)
  })
  return lines.join("\n")
}

export async function addServer(name, note = "") {
  const cleanName = sanitizeServerName(name)
  if (!cleanName) throw new Error("服务器名不能为空")
  const cleanNote = String(note || "").trim()
  const config = await updateConfig(current => {
    if (current.servers.some(item => item.name === cleanName)) throw new Error(`服务器【${cleanName}】已存在`)
    if (current.servers.length >= MAX_SERVERS) throw new Error(`服务器数量已达上限（${MAX_SERVERS}）`)
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

export async function bindServerToken(nameOrToken, token = "", note = "设备侧生成 token") {
  await bootstrap()
  let cleanName = sanitizeServerName(nameOrToken)
  let cleanToken = String(token || "").trim()
  let pending = null

  if (!cleanToken) {
    cleanToken = String(nameOrToken || "").trim()
    if (!cleanToken || cleanToken.length < 8) throw new Error("token格式错误")
    const already = resolveConfigByToken(cleanToken)
    if (already) return { ...already, alreadyBound: true }
    pending = state.pendingReports.get(cleanToken) || null
    if (!pending) throw new Error("未收到该 token 的服务器上报，请先在子服务器启动 agent，或使用 #服务器状态绑定 <名称> <token>")
    cleanName = sanitizeServerName(pending.name)
  } else {
    pending = state.pendingReports.get(cleanToken) || null
  }

  const cleanNote = String(note || "").trim() || "设备侧生成 token"
  if (!cleanName) throw new Error("服务器名不能为空")
  if (!cleanToken || cleanToken.length < 8) throw new Error("token格式错误")

  const config = await updateConfig(current => {
    const conflict = current.servers.find(item => item.name !== cleanName && item.token === cleanToken)
    if (conflict) throw new Error(`token已绑定服务器【${conflict.name}】`)
    const existing = current.servers.find(item => item.name === cleanName)
    if (existing) {
      if (existing.token !== cleanToken) throw new Error(`服务器【${cleanName}】已绑定其他 token`)
      existing.note = cleanNote
      existing.boundAt = Date.now()
    } else {
      if (current.servers.length >= MAX_SERVERS) throw new Error(`服务器数量已达上限（${MAX_SERVERS}）`)
      current.servers.push({
        name: cleanName,
        token: cleanToken,
        note: cleanNote,
        createdAt: Date.now(),
      })
    }
    return current
  })
  await refreshConfig()
  ensureRecord(cleanName)

  if (pending) {
    if (pending.snap) {
      pending.snap.name = cleanName
      updateRecordFromSnapshot(cleanName, pending.snap, pending.lastSeen || Date.now())
    }
    state.pendingReports.delete(cleanToken)
    await persistPending()
  }

  return config.servers.find(item => item.name === cleanName)
}

export async function renameServer(oldName, newName) {
  await bootstrap()
  const cleanOld = String(oldName || "").trim()
  const cleanNew = sanitizeServerName(newName)
  if (!cleanOld || !cleanNew) throw new Error("服务器名不能为空")
  if (cleanOld === cleanNew) throw new Error("新旧名称相同")

  const record = state.records.get(cleanOld)
  const config = await updateConfig(current => {
    const item = current.servers.find(server => server.name === cleanOld)
    if (!item) throw new Error(`未找到服务器【${cleanOld}】`)
    if (current.servers.some(server => server.name === cleanNew)) throw new Error(`服务器【${cleanNew}】已存在`)
    item.name = cleanNew
    item.renamedAt = Date.now()
    return current
  })

  if (record) {
    state.records.delete(cleanOld)
    if (record.snap) record.snap.name = cleanNew
    state.records.set(cleanNew, record)
  }
  await refreshConfig()
  return config.servers.find(item => item.name === cleanNew)
}

export async function removeServer(name) {
  await bootstrap()
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
  const log = globalThis.logger || console
  try {
    await bootstrap()
    let config = await refreshConfig()
    const token = String(req.get("X-SM-Token") || "").trim()
    const tokenTail = token ? token.slice(-6) : ""
    if (token.length > 128) return res.status(422).json({ ok: false, msg: "token too long" })
    if (!allowReport(req, token)) return res.status(429).json({ ok: false, msg: "too many requests" })
    const body = req.body
    if (!body || typeof body !== "object" || body.v !== 1) {
      return res.status(422).json({ ok: false, msg: "bad schema" })
    }

    let server = resolveConfigByToken(token)
    const isSharedToken = token && timingSafeEqualStrings(token, config.shared_token)
    if (!server && isSharedToken) {
      const autoName = sanitizeServerName(body.name || body.os?.hostname)
      if (!autoName) return res.status(422).json({ ok: false, msg: "missing name" })
      const existingByName = resolveConfigServer(autoName)
      if (existingByName) {
        log.warn?.(`[servermonitor] report rejected: shared token name conflict ${autoName} token=...${tokenTail}`)
        return res.status(403).json({ ok: false, msg: "name conflict" })
      }
      if ((config.servers?.length || 0) >= MAX_SERVERS) {
        log.warn?.(`[servermonitor] report rejected: server cap reached token=...${tokenTail}`)
        return res.status(429).json({ ok: false, msg: "server limit reached" })
      }
      server = resolveConfigServer(autoName)
      if (!server) {
        config = await updateConfig(current => {
          if (!current.servers.some(item => item.name === autoName)) {
            current.servers.push({
              name: autoName,
              token: makeToken(),
              note: "共享 token 自动注册",
              createdAt: Date.now(),
            })
          }
          return current
        })
        await refreshConfig()
        server = config.servers.find(item => item.name === autoName) || resolveConfigServer(autoName)
      }
    }

    const snap = sanitizeSnapshot(body)
    if (isEmptySnapshot(snap)) {
      log.warn?.(`[servermonitor] report rejected: empty snapshot token=...${tokenTail}`)
      return res.status(422).json({ ok: false, msg: "empty snapshot" })
    }

    if (!server) {
      const pending = await savePendingReport(token, snap, Date.now())
      if (pending) {
        log.info?.(`[servermonitor] report pending saved: name=${pending.name} token=...${tokenTail}`)
        return res.status(202).json({
          ok: true,
          pending: true,
          name: pending.name,
          bind: `#服务器状态绑定 ${token}`,
        })
      }
      log.warn?.(`[servermonitor] report rejected: missing token/name token=...${tokenTail}`)
      return res.status(401).json({ ok: false, msg: "token invalid" })
    }

    snap.name = server.name
    const wasOffline = state.records.get(server.name)?.state === "offline"
    updateRecordFromSnapshot(server.name, snap, Date.now())

    if (wasOffline && config.alert?.enabled) {
      const record = state.records.get(server.name)
      const cooldownMs = (config.alert?.cooldown || 120) * 1000
      if (record && Date.now() - (record.alertedAt || 0) >= cooldownMs) {
        try {
          if (globalThis.Bot?.sendMasterMsg) {
            await Bot.sendMasterMsg(`✅ 服务器【${server.name}】已恢复在线`)
            record.alertedAt = Date.now()
          }
        } catch (err) {
          log.warn?.("[servermonitor] recovery alert failed", err)
        }
      }
    }

    log.info?.(`[servermonitor] report accepted: name=${server.name} token=...${tokenTail}${isSharedToken ? " shared" : ""}`)
    return res.json({ ok: true, name: server.name, auto: isSharedToken })
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
      const sentAt = Date.now()
      for (const item of alerts) {
        const record = state.records.get(item.name)
        if (record) record.alertedAt = sentAt
      }
    } catch (err) {
      ;(globalThis.logger || console).warn("[servermonitor] sendMasterMsg failed", err)
    }
  }

  return alerts
}

export async function persist() {
  try {
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
    await atomicWriteJson(SNAPSHOT_FILE, payload)
    state.lastPersistAt = Date.now()
    return payload
  } catch (err) {
    ;(globalThis.logger || console).warn("[servermonitor] persist failed", err)
    return null
  }
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
