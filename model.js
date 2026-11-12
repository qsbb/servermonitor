import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { collectLocalSnapshot } from "./local.js"
import { DATA_DIR, SNAPSHOT_FILE, PENDING_FILE, HISTORY_FILE, loadConfig, updateConfig, makeToken, ensureConfigExists } from "./config.js"
import { ALERT_METRIC_LABELS, evaluateAlertRules, inQuietHours, parseQuietHours, pruneAlertStates } from "./alert.js"
import { HISTORY_VERSION, buildTrendData, createHistorySeries, fitHistoryToBudget, ingestPoint, pruneHistoryServers } from "./history.js"

const STATE_KEY = "__servermonitor_state__"
const state = globalThis[STATE_KEY] ??= {
  config: null,
  configIndexByName: new Map(),
  configIndexByToken: new Map(),
  records: new Map(),
  pendingReports: new Map(),
  alertStates: new Map(),
  history: null,
  bootstrapPromise: null,
  persistedLoaded: false,
  lastPersistAt: 0,
  pendingPersistAt: 0,
  pendingDirty: false,
  reportRate: new Map(),
  rateSweepStarted: false,
}
const MAX_SERVERS = 64
const PENDING_WRITE_DEBOUNCE_MS = 10_000
const MAX_PENDING_ENTRIES = 100
const MAX_PENDING_PER_IP_MIN = 10
const MAX_REPORTS_PER_MIN = 60
const MAX_REPORTS_PER_IP_MIN = 240
const RATE_MAP_MAX = 10_000
const RATE_SWEEP_MS = 5 * 60 * 1000
const PENDING_TOKEN_RE = /^sm_[0-9a-f]{32}$/
const LOCAL_SNAPSHOT_TTL_MS = 5_000
// pending 防填充：真实 agent 每 SM_INTERVAL 秒重发，pending 条目永远新鲜；
// 只有攻击者填充的条目会随时间陈旧。按 IP 限条目数 + 满时回收陈旧条目，
// 避免公网匿名流量用 100 个随机 token 阻塞正常绑定流程 24 小时。
const PENDING_STALE_MS = 60 * 60 * 1000
const MAX_PENDING_PER_IP = 10

let trustedProxyCache = []

function clone(value) {
  return JSON.parse(JSON.stringify(value))
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

function normalizeIp(value) {
  let ip = String(value || "").trim()
  if (!ip) return ""
  if (ip.toLowerCase().startsWith("::ffff:")) ip = ip.slice(7)
  if (ip.startsWith("[")) {
    const end = ip.indexOf("]")
    if (end > 0) ip = ip.slice(1, end)
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.slice(0, ip.lastIndexOf(":"))
  }
  return ip
}

export function resolveClientIp(req, trustedProxies = trustedProxyCache) {
  const direct = normalizeIp(req?.socket?.remoteAddress || req?.ip || "")
  const trusted = Array.isArray(trustedProxies) ? trustedProxies.map(normalizeIp).filter(Boolean) : []
  if (!direct || !trusted.includes(direct)) return direct || "unknown"
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "")
    .split(",")
    .map(normalizeIp)
    .filter(Boolean)
  for (let i = forwarded.length - 1; i >= 0; i--) {
    if (!trusted.includes(forwarded[i])) return forwarded[i]
  }
  return direct
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex").slice(0, 16)
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

export function sweepRateLimits(now = Date.now()) {
  for (const [key, item] of state.reportRate) {
    if (!item || now > item.resetAt) state.reportRate.delete(key)
  }
  if (state.reportRate.size <= RATE_MAP_MAX) return
  const ordered = [...state.reportRate.entries()].sort((a, b) => (a[1].resetAt || 0) - (b[1].resetAt || 0))
  for (const [key] of ordered.slice(0, state.reportRate.size - RATE_MAP_MAX)) state.reportRate.delete(key)
}

function startRateSweep() {
  if (state.rateSweepStarted) return
  state.rateSweepStarted = true
  const timer = setInterval(() => sweepRateLimits(), RATE_SWEEP_MS)
  timer.unref?.()
}

startRateSweep()

function allowReport(ip, token) {
  if (!rateLimit(`ip:${ip}`, MAX_REPORTS_PER_IP_MIN)) return false
  if (!rateLimit(`token:${hashToken(token)}:${ip}`, MAX_REPORTS_PER_MIN)) return false
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

// 磁盘 SMART 白名单：只保留已知字段，数字取整并限幅，全空则视为没有数据。
function sanitizeDiskSmart(value) {
  if (!value || typeof value !== "object") return null
  const smart = {
    passed: typeof value.passed === "boolean" ? value.passed : null,
    temp: clampTemp(value.temp),
    powerOnHours: clampNonNegative(value.powerOnHours, 10_000_000),
    reallocated: clampNonNegative(value.reallocated, 100_000_000),
    pending: clampNonNegative(value.pending, 100_000_000),
    mediaErrors: clampNonNegative(value.mediaErrors, 100_000_000),
  }
  if (Object.values(smart).every(item => item === null)) return null
  return {
    passed: smart.passed,
    temp: smart.temp,
    powerOnHours: smart.powerOnHours === null ? null : Math.round(smart.powerOnHours),
    reallocated: smart.reallocated === null ? null : Math.round(smart.reallocated),
    pending: smart.pending === null ? null : Math.round(smart.pending),
    mediaErrors: smart.mediaErrors === null ? null : Math.round(smart.mediaErrors),
  }
}

// 采集健康度时间戳：钳制到合理区间，非法值一律 null（不信任上报方）。
function sanitizeHealth(value) {
  const source = value && typeof value === "object" ? value : {}
  const now = Date.now()
  const clampTs = item => {
    const n = numOrNull(item)
    if (n === null) return null
    if (n > now + 5 * 60 * 1000 || n < now - 365 * 24 * 60 * 60 * 1000) return null
    return n
  }
  const health = {
    fastAt: clampTs(source.fastAt),
    slowAt: clampTs(source.slowAt),
    smartAt: clampTs(source.smartAt),
  }
  return Object.values(health).every(item => item === null) ? null : health
}

function clampPower(value) {
  const n = numOrNull(value)
  if (n === null || n < 0 || n > 10000) return null
  return n
}

async function atomicWriteJson(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 })
  await fs.rename(tmp, file)
  await fs.chmod(file, 0o600).catch(() => {})
}

export function isEmptySnapshot(snap) {
  if (!snap || typeof snap !== "object") return true
  const hasCpu = snap.cpu?.usage !== null || snap.cpu?.cores !== null || snap.cpu?.model !== null
  const hasMem = snap.mem?.total !== null || snap.mem?.used !== null || snap.mem?.available !== null
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
  trustedProxyCache = Array.isArray(config.trusted_proxies) ? config.trusted_proxies : []
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
    // 阈值告警状态：只接受已知字段，非法条目丢弃
    if (parsed?.alerts && typeof parsed.alerts === "object") {
      for (const [name, states] of Object.entries(parsed.alerts)) {
        if (!states || typeof states !== "object") continue
        const clean = {}
        for (const [key, value] of Object.entries(states)) {
          if (!value || typeof value !== "object") continue
          clean[key] = {
            since: Number(value.since) || 0,
            fired: Boolean(value.fired),
            lastFiredAt: Number(value.lastFiredAt) || 0,
            suppressed: Boolean(value.suppressed),
          }
        }
        state.alertStates.set(String(name), clean)
      }
    }
  } catch {}
}

async function hydrateHistory() {
  try {
    const raw = await fs.readFile(HISTORY_FILE, "utf8")
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && parsed.series && typeof parsed.series === "object") {
      state.history = {
        v: HISTORY_VERSION,
        savedAt: Number(parsed.savedAt) || 0,
        series: parsed.series,
      }
      return
    }
  } catch (err) {
    // 文件损坏时备份后从空历史开始，不阻塞插件启动
    if (err?.code !== "ENOENT") {
      const backup = `${HISTORY_FILE}.corrupt-${Date.now()}`
      await fs.copyFile(HISTORY_FILE, backup).catch(() => {})
      ;(globalThis.logger || console).warn(`[servermonitor] history.json 解析失败，已备份到 ${backup}`)
    }
  }
  state.history = state.history || { v: HISTORY_VERSION, savedAt: 0, series: {} }
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
          firstSeen: Number(item.firstSeen) || Number(item.lastSeen) || Date.now(),
          ip: String(item.ip || ""),
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
  state.pendingDirty = false
  state.pendingPersistAt = Date.now()
}

async function savePendingReport(token, snap, receivedAt = Date.now(), ip = "") {
  const cleanToken = String(token || "").trim()
  const cleanName = sanitizeServerName(snap?.name || snap?.os?.hostname)
  if (!cleanToken || !cleanName) return null
  const prev = state.pendingReports.get(cleanToken)
  const item = { token: cleanToken, name: cleanName, snap, lastSeen: receivedAt, firstSeen: prev?.firstSeen || receivedAt, ip: ip || prev?.ip || "" }
  state.pendingReports.set(cleanToken, item)
  state.pendingDirty = true
  const shouldPersist = Date.now() - (state.pendingPersistAt || 0) >= PENDING_WRITE_DEBOUNCE_MS
  if (shouldPersist) await persistPending()
  return item
}

function countPendingByIp(ip) {
  if (!ip) return 0
  let count = 0
  for (const item of state.pendingReports.values()) {
    if (item.ip === ip) count++
  }
  return count
}

// 队列满时回收陈旧条目（超过 1 小时没再上报的 token 视为垃圾填充），
// 回收失败且按 IP 计数已满时拒绝入队。
function tryEvictStalePending(now = Date.now()) {
  let evicted = 0
  for (const [key, item] of state.pendingReports) {
    if (now - (item.lastSeen || 0) > PENDING_STALE_MS) {
      state.pendingReports.delete(key)
      evicted++
    }
  }
  if (evicted) state.pendingDirty = true
  return evicted
}

async function bootstrap() {
  if (!state.bootstrapPromise) {
    state.bootstrapPromise = (async () => {
      await hydratePersisted()
      await hydratePending()
      await hydrateHistory()
      await hydrateConfig()
    })().catch(err => {
      state.bootstrapPromise = null
      throw err
    })
  }
  return state.bootstrapPromise
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

export function sanitizeSnapshot(body) {
  const os = body.os && typeof body.os === "object" ? body.os : {}
  const cpu = body.cpu && typeof body.cpu === "object" ? body.cpu : {}
  const mem = body.mem && typeof body.mem === "object" ? body.mem : {}
  const net = body.net && typeof body.net === "object" ? body.net : {}
  const disks = Array.isArray(body.disks)
    ? body.disks
        .slice(0, 16)
        .map(item => {
          if (!item || typeof item !== "object") return null
          const device = typeof item.device === "string" && /^\/dev\/[A-Za-z0-9._-]{1,64}$/.test(item.device)
            ? item.device
            : null
          return {
            mount: strOrNull(item.mount, 128),
            used: clampNonNegative(item.used),
            total: clampNonNegative(item.total),
            device,
            smart: sanitizeDiskSmart(item.smart),
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

  const memory = resolveMemoryUsage(mem)

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
      used: memory.used,
      total: memory.total,
      available: memory.available,
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
    health: sanitizeHealth(body.health),
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

async function getCachedLocalSnapshot() {
  const now = Date.now()
  const cached = state.localSnapshot
  if (cached && now - cached.at < LOCAL_SNAPSHOT_TTL_MS) return cached.snap
  let raw
  try {
    raw = await collectLocalSnapshot()
  } catch {
    raw = buildBasicLocalSnapshot()
  }
  const snap = sanitizeSnapshot(raw || buildBasicLocalSnapshot())
  state.localSnapshot = { at: now, snap }
  return snap
}

async function buildLocalEntry(timeoutMs = 30000, now = Date.now(), options = {}) {
  const snap = await getCachedLocalSnapshot()
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
  return decorateEntry(conf, record, now, timeoutMs, options)
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

export function resolveMemoryUsage(mem = {}) {
  const total = clampNonNegative(mem?.total)
  let used = clampNonNegative(mem?.used)
  let available = clampNonNegative(mem?.available)

  if (total !== null) {
    if (used !== null && used > total) used = total
    if (available !== null && available > total) available = total
  }

  if (total === null || total <= 0) {
    return {
      used,
      total,
      available,
      effectiveUsed: null,
      effectiveAvailable: null,
      source: null,
    }
  }

  if (available !== null) {
    return {
      used,
      total,
      available,
      effectiveUsed: total - available,
      effectiveAvailable: available,
      source: "available",
    }
  }

  return {
    used,
    total,
    available: null,
    effectiveUsed: used,
    effectiveAvailable: used === null ? null : total - used,
    source: used === null ? null : "used",
  }
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
  const memory = resolveMemoryUsage(snap?.mem)
  const mem = computeUsagePercent(memory.effectiveUsed, memory.total)
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

function shortenCpuModel(name) {
  const text = String(name || "").trim()
  if (!text) return ""
  return text
    .replace(/\((r|tm)\)/gi, "")
    .replace(/[®™]/g, "")
    .replace(/\bCPU\b/gi, " ")
    .replace(/\bProcessor\b/gi, " ")
    .replace(/\s*@\s*[\d.]+\s*GHz\s*$/i, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
}

export function decorateEntry(conf, record, now = Date.now(), timeoutMs = 30000, options = {}) {
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

  const memory = resolveMemoryUsage(snap?.mem)
  const memUsed = memory.effectiveUsed
  const memTotal = memory.total
  const memPct = computeUsagePercent(memUsed, memTotal)
  const memText = snap ? `${formatSizeGB(memUsed)} / ${formatSizeGB(memTotal)}` : "—"
  const swapText = snap
    ? `${formatSizeGB(numOrNull(snap.mem?.swapUsed))} / ${formatSizeGB(numOrNull(snap.mem?.swapTotal))}`
    : "—"
  const cpuCoresText = snap ? (numOrNull(snap.cpu?.cores) ?? "—") : "—"

  // 网络固定两行：实时（上传/下载）与累计（上传/下载），避免四行把卡片撑高
  const netLines = []
  if (snap) {
    const rateParts = [
      snap.net?.rxSec !== null && snap.net?.rxSec !== undefined ? `↓ ${formatRateMB(snap.net.rxSec)}` : null,
      snap.net?.txSec !== null && snap.net?.txSec !== undefined ? `↑ ${formatRateMB(snap.net.txSec)}` : null,
    ].filter(Boolean)
    if (rateParts.length) netLines.push(`实时 ${rateParts.join(" · ")}`)

    const totalParts = [
      snap.net?.rxTotal !== null && snap.net?.rxTotal !== undefined ? `↓ ${formatSizeGB(snap.net.rxTotal)}` : null,
      snap.net?.txTotal !== null && snap.net?.txTotal !== undefined ? `↑ ${formatSizeGB(snap.net.txTotal)}` : null,
    ].filter(Boolean)
    if (totalParts.length) netLines.push(`累计 ${totalParts.join(" · ")}`)
  }
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
  const smartFailing = allDisks.filter(d => d?.smart && d.smart.passed === false)
  const hasSmartWarning = smartFailing.length > 0
  const smartWarningText = hasSmartWarning
    ? `磁盘 SMART 告警：${smartFailing.map(d => `${d.mount || "?"}${d.smart.reallocated ? `（重分配 ${d.smart.reallocated}）` : ""}`).join("、")}`
    : ""
  // 采集健康度：慢采集（磁盘/GPU/温度/功耗）超过 stale_after 秒未更新即视为过期
  const staleAfterMs = Math.max(0, Number(options?.staleAfter ?? 90)) * 1000
  const snapTs = numOrNull(snap?.agent_ts)
  const fastTs = numOrNull(snap?.health?.fastAt) ?? snapTs ?? numOrNull(record?.lastSeen)
  const slowTs = numOrNull(snap?.health?.slowAt) ?? snapTs ?? numOrNull(record?.lastSeen)
  const isStale = staleAfterMs > 0 && Boolean(snap)
  const fastStale = isStale && fastTs !== null && now - fastTs > staleAfterMs
  const slowStale = isStale && slowTs !== null && now - slowTs > staleAfterMs
  const diskOverflow = Math.max(0, allDisks.length - 8)
  const diskView = snap
    ? allDisks
        .map(d => {
          const pct = computeUsagePercent(d.used, d.total)
          const used = formatSizeGB(d.used)
          const total = formatSizeGB(d.total)
          const smart = d.smart && typeof d.smart === "object" ? d.smart : null
          return {
            mount: String(d.mount || "?"),
            pct: pct ?? 0,
            hasPct: pct !== null,
            color: severityColor(pct ?? 0),
            text: `${used}/${total}`,
            usedText: used,
            totalText: total,
            device: d.device || null,
            smart,
            smartFailed: Boolean(smart && smart.passed === false),
            smartText: smart
              ? [
                  smart.passed === false ? "SMART 告警" : smart.passed === true ? "SMART 正常" : null,
                  smart.temp !== null && smart.temp !== undefined ? `${formatTemp(smart.temp)}` : null,
                  smart.powerOnHours !== null && smart.powerOnHours !== undefined ? `通电 ${smart.powerOnHours}h` : null,
                ].filter(Boolean).join(" · ") || "—"
              : "",
          }
        })
        .sort((a, b) => b.pct - a.pct)
        .slice(0, 8)
    : []
  const gpuView = snap ? buildGpuView(snap) : { hasGpu: false, gpuEmptyText: "—", gpus: [] }

  // 普通视图只展示磁盘总占用，pro 视图才展开每个挂载点
  let sumUsed = 0
  let sumTotal = 0
  let sumCount = 0
  for (const d of allDisks) {
    const used = numOrNull(d?.used)
    const total = numOrNull(d?.total)
    if (used === null || total === null || total <= 0) continue
    sumUsed += used
    sumTotal += total
    sumCount += 1
  }
  const diskPct = computeUsagePercent(sumUsed, sumTotal)
  const diskSummary = {
    count: sumCount,
    pct: diskPct ?? 0,
    hasPct: diskPct !== null,
    color: severityColor(diskPct ?? 0),
    text: sumCount ? `${formatSizeGB(sumUsed)} / ${formatSizeGB(sumTotal)}` : "—",
  }
  // 粗略的卡片高度（行数），pro 视图按它从长到短排列
  const cardRows = 10 + diskView.length * 2 + (gpuView.gpus?.length || 0) * 2
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
    cpuModel: shortenCpuModel(snap?.cpu?.model) || "未知 CPU",
    cpuPct: cpuUsage,
    cpuColor: cpuUsage === null ? "#98a0b3" : severityColor(cpuUsage),
    cpuText,
    cpuCoresText,
    memText,
    memAvailable: memory.effectiveAvailable,
    memSource: memory.source,
    swapText,
    memPct,
    memColor: severityColor(memPct ?? 0),
    diskText,
    disks: diskView,
    diskSummary,
    cardRows,
    pro: Boolean(options?.pro),
    diskOverflow,
    hasSmartWarning,
    smartWarningText,
    fastStale,
    slowStale,
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

export function shouldShowLocalEntry(config) {
  if (!config?.include_local) return false
  const servers = Array.isArray(config.servers) ? config.servers : []
  if (servers.some(conf => isLocalName(conf.name))) return false
  // Yunzai 和 agent 跑在同一台机器时，“本机”卡片会和那台机器的 agent 卡片重复。
  // 不做任何自动猜测（主机名、内网 IP 都可能重名或被容器改写），由配置显式声明。
  const declared = String(config.local_server_name || "").trim()
  if (declared) return !servers.some(conf => String(conf.name) === declared)
  return true
}

export async function getEntries(options = {}) {
  await bootstrap()
  const config = await refreshConfig()
  const timeoutMs = config.offline_timeout * 1000
  const now = Date.now()
  const decorateOptions = { ...options, staleAfter: options.staleAfter ?? config.stale_after }
  const registered = config.servers.map(conf => decorateEntry(conf, state.records.get(conf.name) ?? null, now, timeoutMs, decorateOptions))
  if (!shouldShowLocalEntry(config)) return registered
  const local = [await buildLocalEntry(timeoutMs, now)]
  return [...local, ...registered]
}

export async function getEntryByName(name) {
  await bootstrap()
  const config = await refreshConfig()
  const timeoutMs = config.offline_timeout * 1000
  const now = Date.now()
  const conf = resolveConfigServer(name)
  const decorateOptions = { staleAfter: config.stale_after }
  if (!conf) return isLocalName(name) ? await buildLocalEntry(timeoutMs, now, decorateOptions) : null
  return decorateEntry(conf, state.records.get(conf.name) ?? null, now, timeoutMs, decorateOptions)
}

export async function buildStatusData(entries, pageNum = 1, pageCount = 1, allEntries = null, config = null, options = {}) {
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
  const pro = Boolean(options?.pro)
  return {
    summary,
    servers: list,
    pageNum,
    pageCount,
    detail: false,
    pro,
    simpleStyle: pro ? "pro" : (config.simple_style || "bars"),
    updateTime: new Date().toLocaleString("zh-CN", { hour12: false }),
    pageSize: config.page_size,
    imgType: config.render?.imgType || "png",
    layout: pro
      ? { cols: Math.max(1, list.length), mode: "pro" }
      : {
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
  const entries = config.servers.map(conf => decorateEntry(conf, state.records.get(conf.name) ?? null, now, timeoutMs, { staleAfter: config.stale_after }))
  if (!entries.length) return "尚未注册服务器；发送 #服务器状态 将显示本机状态。"

  const lines = []
  lines.push(`已注册 ${entries.length} 台服务器`)
  entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
  entries.forEach((item, idx) => {
    lines.push(`${idx + 1}. ${item.name} · ${item.stateText} · ${item.dataAgeText}${item.noteText ? ` · ${item.noteText}` : ""}`)
  })
  return lines.join("\n")
}

export async function addServer(name, note = "", reportUrl = "") {
  const cleanName = sanitizeServerName(name)
  if (!cleanName) throw new Error("服务器名不能为空")
  const cleanNote = String(note || "").trim()
  const cleanReportUrl = String(reportUrl || "").trim()
  const config = await updateConfig(current => {
    if (current.servers.some(item => item.name === cleanName)) throw new Error(`服务器【${cleanName}】已存在`)
    if (current.servers.length >= MAX_SERVERS) throw new Error(`服务器数量已达上限（${MAX_SERVERS}）`)
    const item = {
      name: cleanName,
      token: makeToken(),
      note: cleanNote,
      createdAt: Date.now(),
    }
    if (cleanReportUrl) item.reportUrl = cleanReportUrl
    current.servers.push(item)
    return current
  })
  await refreshConfig()
  ensureRecord(cleanName)
  return config.servers.find(item => item.name === cleanName)
}

export async function bindServerToken(nameOrToken, token = "", note = "设备侧生成 token", reportUrl = "", { confirmName = false } = {}) {
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
    // pending.name 来自被监控端自报（上报接口对公网开放，可能被伪造），
    // token-only 绑定必须由主人显式确认名称后才采用。
    if (!confirmName) {
      throw new Error(
        `待绑定名称【${pending.name}】来自被监控端自报，可能不准确。`
        + `确认无误请发送：#服务器状态确认绑定 ${cleanToken} ${pending.name}`
        + `；或直接指定名称：#服务器状态绑定 <名称> ${cleanToken}`,
      )
    }
    cleanName = sanitizeServerName(pending.name)
  } else {
    pending = state.pendingReports.get(cleanToken) || null
  }

  const cleanNote = String(note || "").trim() || "设备侧生成 token"
  const cleanReportUrl = String(reportUrl || "").trim()
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
      if (cleanReportUrl) existing.reportUrl = cleanReportUrl
    } else {
      if (current.servers.length >= MAX_SERVERS) throw new Error(`服务器数量已达上限（${MAX_SERVERS}）`)
      const item = {
        name: cleanName,
        token: cleanToken,
        note: cleanNote,
        createdAt: Date.now(),
      }
      if (cleanReportUrl) item.reportUrl = cleanReportUrl
      current.servers.push(item)
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
  const alertStates = state.alertStates.get(cleanOld)
  if (alertStates) {
    state.alertStates.delete(cleanOld)
    state.alertStates.set(cleanNew, alertStates)
  }
  if (state.history?.series?.[cleanOld]) {
    state.history.series[cleanNew] = state.history.series[cleanOld]
    delete state.history.series[cleanOld]
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
  state.alertStates.delete(cleanName)
  if (state.history?.series) delete state.history.series[cleanName]
  await refreshConfig()
  return config
}

export async function handleReport(req, res) {
  const log = globalThis.logger || console
  try {
    const token = String(req.get("X-SM-Token") || "").trim()
    const tokenTail = token ? token.slice(-6) : ""
    const ip = resolveClientIp(req)
    if (!allowReport(ip, token)) return res.status(429).json({ ok: false, msg: "too many requests" })
    if (token.length > 128) return res.status(422).json({ ok: false, msg: "token too long" })

    await bootstrap()
    const config = await refreshConfig()
    if (!config.report_enabled) {
      return res.status(503).json({ ok: false, msg: "report ingestion disabled" })
    }

    const isSharedToken = Boolean(config.shared_token && token && timingSafeEqualStrings(token, config.shared_token))
    if (isSharedToken) {
      log.warn?.(`[servermonitor] shared token disabled token=...${tokenTail}`)
      return res.status(401).json({
        ok: false,
        msg: "shared token disabled",
        hint: "共享 token 已停用；请使用独立 token，可在 Yunzai 私聊执行 #服务器状态命令 <名称> 获取",
      })
    }

    const body = req.body
    if (!body || typeof body !== "object" || body.v !== 1) {
      return res.status(422).json({ ok: false, msg: "bad schema" })
    }

    const server = resolveConfigByToken(token)

    const snap = sanitizeSnapshot(body)
    if (isEmptySnapshot(snap)) {
      log.warn?.(`[servermonitor] report rejected: empty snapshot token=...${tokenTail}`)
      return res.status(422).json({ ok: false, msg: "empty snapshot" })
    }

    if (!server) {
      if (!PENDING_TOKEN_RE.test(token)) {
        log.warn?.(`[servermonitor] report rejected: invalid token format token=...${tokenTail}`)
        return res.status(401).json({ ok: false, msg: "token invalid" })
      }
      if (!rateLimit(`pending:${ip}`, MAX_PENDING_PER_IP_MIN)) {
        log.warn?.(`[servermonitor] report rejected: pending rate limit ip=${ip}`)
        return res.status(429).json({ ok: false, msg: "pending rate limit" })
      }
      if (state.pendingReports.size >= MAX_PENDING_ENTRIES && !state.pendingReports.has(token)) {
        if (!tryEvictStalePending()) {
          log.warn?.(`[servermonitor] report rejected: pending queue full size=${state.pendingReports.size}`)
          return res.status(429).json({ ok: false, msg: "pending queue full" })
        }
      }
      if (!state.pendingReports.has(token) && countPendingByIp(ip) >= MAX_PENDING_PER_IP) {
        log.warn?.(`[servermonitor] report rejected: pending per-ip limit ip=${ip}`)
        return res.status(429).json({ ok: false, msg: "pending per-ip limit" })
      }
      const pending = await savePendingReport(token, snap, Date.now(), ip)
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

    log.info?.(`[servermonitor] report accepted: name=${server.name} token=...${tokenTail}`)
    return res.json({ ok: true, name: server.name, auto: false })
  } catch (err) {
    ;(globalThis.logger || console).error("[servermonitor] report failed", err)
    return res.status(500).json({ ok: false, msg: "internal error" })
  }
}

// 从快照里提取告警规则需要的指标（一个规则只关心一个标量）。
export function buildAlertMetrics(snap) {
  if (!snap || typeof snap !== "object") return {}
  const metrics = {}
  const cpu = clampPercent(snap.cpu?.usage)
  if (cpu !== null) metrics.cpu_usage = cpu

  const memory = resolveMemoryUsage(snap.mem)
  const memPct = computeUsagePercent(memory.effectiveUsed, memory.total)
  if (memPct !== null) metrics.mem_usage = +memPct.toFixed(1)

  const disks = Array.isArray(snap.disks) ? snap.disks : []
  const diskPct = disks.reduce((max, disk) => {
    const pct = computeUsagePercent(disk?.used, disk?.total)
    return pct !== null && pct > max ? pct : max
  }, -1)
  if (diskPct >= 0) metrics.disk_usage = +diskPct.toFixed(1)
  // smart_failed 用 1/0 表示，阈值固定 1
  metrics.smart_failed = disks.some(disk => disk?.smart?.passed === false) ? 1 : 0

  const gpus = Array.isArray(snap.gpus) ? snap.gpus : []
  const gpuPct = gpus.reduce((max, gpu) => {
    const value = clampPercent(gpu?.usage)
    return value !== null && value > max ? value : max
  }, -1)
  if (gpuPct >= 0) metrics.gpu_usage = +gpuPct.toFixed(1)
  const gpuTemp = gpus.reduce((max, gpu) => {
    const value = clampTemp(gpu?.temp)
    return value !== null && value > max ? value : max
  }, -1)
  if (gpuTemp >= 0) metrics.gpu_temp = +gpuTemp.toFixed(1)
  return metrics
}

function formatAlertValue(metric, value) {
  if (value === null || value === undefined) return "—"
  if (metric === "gpu_temp") return formatTemp(value)
  if (metric === "smart_failed") return value >= 1 ? "异常" : "正常"
  return formatPercent(value)
}

function formatAlertEvent(event) {
  const rule = event.rule
  const label = ALERT_METRIC_LABELS[rule.metric] || rule.metric
  if (rule.metric === "smart_failed") {
    return event.type === "recover"
      ? `✅ 服务器【${event.serverName}】磁盘 SMART 已恢复正常`
      : `⚠️ 服务器【${event.serverName}】磁盘 SMART 健康状态异常（检测到故障盘）`
  }
  if (event.type === "recover") {
    return `✅ 服务器【${event.serverName}】${label}已恢复${event.value === null ? "" : `（当前 ${formatAlertValue(rule.metric, event.value)}）`}`
  }
  const hold = rule.for ? `，持续 ${formatDuration(rule.for)}` : ""
  const resumed = event.resumed ? "（静默结束补发）" : ""
  const unit = rule.metric === "gpu_temp" ? "℃" : "%"
  return `⚠️ 服务器【${event.serverName}】${label} ${formatAlertValue(rule.metric, event.value)}，达到阈值 ${rule.threshold}${unit}${hold}${resumed}`
}

// --- 历史数据 -----------------------------------------------------------
function buildHistoryPoint(snap, now = Date.now()) {
  if (!snap) return null
  const memory = resolveMemoryUsage(snap.mem)
  const gpus = Array.isArray(snap.gpus) ? snap.gpus : []
  const gpuPct = gpus.reduce((max, gpu) => {
    const value = clampPercent(gpu?.usage)
    return value !== null && value > max ? value : max
  }, -1)
  return {
    t: now,
    c: clampPercent(snap.cpu?.usage),
    m: computeUsagePercent(memory.effectiveUsed, memory.total),
    rx: clampNonNegative(snap.net?.rxSec, 1024 * 1024),
    tx: clampNonNegative(snap.net?.txSec, 1024 * 1024),
    g: gpuPct >= 0 ? gpuPct : null,
  }
}

// 采样当前在线服务器，滚动聚合到小时/天桶，并做容量裁剪。复用 30s 落盘 tick。
async function recordHistory(now = Date.now()) {
  const config = await refreshConfig()
  if (!config.history?.enabled) return null
  if (!state.history || typeof state.history !== "object") {
    state.history = { v: HISTORY_VERSION, savedAt: 0, series: {} }
  }
  const limits = {
    rawHours: config.history.raw_hours,
    hourlyDays: config.history.hourly_days,
    dailyDays: config.history.daily_days,
  }
  const keepNames = config.servers.map(conf => conf.name)
  state.history = pruneHistoryServers(state.history, keepNames)
  for (const conf of config.servers) {
    const record = state.records.get(conf.name)
    if (!record?.snap || record.state === "offline") continue
    const point = buildHistoryPoint(record.snap, now)
    if (!point) continue
    const series = state.history.series[conf.name] || createHistorySeries()
    state.history.series[conf.name] = ingestPoint(series, point, now, limits)
  }
  state.history = fitHistoryToBudget({ ...state.history, savedAt: now })
  return state.history
}

// 趋势数据：返回 { enabled, empty, charts:[...], name, rangeLabel, summary }。
export async function getTrend(serverName, range = "24h") {
  await bootstrap()
  const config = await refreshConfig()
  const conf = resolveConfigServer(serverName)
  if (!conf) return null
  const safeRange = ["24h", "7d", "30d"].includes(range) ? range : "24h"
  const historyEnabled = config.history?.enabled !== false
  const series = state.history?.series?.[conf.name] || createHistorySeries()
  const data = buildTrendData({ name: conf.name, series, range: safeRange, now: Date.now() })
  return {
    ...data,
    enabled: historyEnabled,
    rawHours: config.history?.raw_hours ?? 6,
    range: safeRange,
    updatedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
  }
}

// 阈值告警评估：每 10s tick 调一次，所有服务器的触发/恢复合并成一条消息。
// 静默时段内只推进状态不发送；静默结束后补发一次（suppressed）。
export async function scanAlerts(now = Date.now()) {
  await bootstrap()
  const config = await refreshConfig()
  const rules = Array.isArray(config.alert?.rules) ? config.alert.rules : []
  if (!config.alert?.enabled || !rules.length) return []

  const quietRanges = parseQuietHours(config.alert.quiet_hours)
  const quiet = inQuietHours(quietRanges, new Date(now))
  const events = []

  for (const conf of config.servers) {
    const record = state.records.get(conf.name)
    if (!record?.snap || record.state === "offline") continue
    const metrics = buildAlertMetrics(record.snap)
    const prevStates = state.alertStates.get(conf.name) || {}
    const result = evaluateAlertRules({
      rules,
      metrics,
      states: prevStates,
      now,
      quiet,
      defaultCooldown: config.alert.cooldown,
    })
    state.alertStates.set(conf.name, pruneAlertStates(result.states, rules))
    for (const event of result.events) events.push({ ...event, serverName: conf.name })
  }

  if (!events.length) return []
  const messages = events.map(formatAlertEvent)
  let sent = false
  try {
    if (globalThis.Bot?.sendMasterMsg) {
      await Bot.sendMasterMsg(messages.join("\n"))
      sent = true
    }
  } catch (err) {
    ;(globalThis.logger || console).warn("[servermonitor] alert send failed", err)
  }
  if (!sent) {
    // 发送失败时回退 fire 事件的状态，让下个 tick 重新尝试
    for (const event of events) {
      if (event.type !== "fire") continue
      const states = state.alertStates.get(event.serverName)
      const st = states?.[event.key]
      if (st) {
        st.fired = false
        st.lastFiredAt = 0
      }
    }
    return []
  }
  return messages
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
    await flushPending()
    await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 })
    const config = await refreshConfig()
    const rules = Array.isArray(config.alert?.rules) ? config.alert.rules : []
    const alerts = {}
    for (const conf of config.servers) {
      const states = pruneAlertStates(state.alertStates.get(conf.name) || {}, rules)
      if (Object.keys(states).length) alerts[conf.name] = states
    }
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
      alerts,
    }
    await atomicWriteJson(SNAPSHOT_FILE, payload)
    state.lastPersistAt = Date.now()
    if (config.history?.enabled) {
      const history = await recordHistory(Date.now())
      if (history) await atomicWriteJson(HISTORY_FILE, history)
    }
    return payload
  } catch (err) {
    ;(globalThis.logger || console).warn("[servermonitor] persist failed", err)
    return null
  }
}

export async function flushPending() {
  if (!state.pendingDirty) return false
  await persistPending()
  return true
}

export function normalizeReportUrl(value, path = "/servermonitor/report") {
  const input = String(value || "").trim()
  let url
  try {
    url = new URL(input)
  } catch {
    throw new Error("上报地址格式错误，请填写以 http:// 或 https:// 开头的地址")
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("上报地址仅支持 http:// 或 https://")
  }
  if (url.username || url.password) throw new Error("上报地址不能包含用户名或密码")
  if (url.search || url.hash) throw new Error("上报地址不能包含查询参数或锚点")

  const pathname = url.pathname.replace(/\/+$/, "")
  const isReportPath = /\/(?:servermonitor|server-monitor)\/report$/.test(pathname)
  const reportPath = isReportPath ? pathname : `${pathname}${path}`
  return `${url.origin}${reportPath || path}`
}

export function parseAddServerExtra(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean)
  const first = parts[0] || ""
  const hasAddress = /^[a-z][a-z0-9+.-]*:\/\//i.test(first)
  return {
    requestedAddress: hasAddress ? parts.shift() : "",
    note: parts.join(" "),
  }
}

export function looksLikeAddressWithoutScheme(value) {
  const text = String(value || "").trim()
  if (!text || /\s/.test(text)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return false
  const hostWithDot = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?::\d{1,5})?(?:\/\S*)?$/
  const bareHostPort = /^[A-Za-z0-9-]+:\d{1,5}(?:\/\S*)?$/
  return hostWithDot.test(text) || bareHostPort.test(text)
}

export function usageHintFor(text) {
  const value = String(text || "")
  if (/服务器状态添加/.test(value)) return "用法：#服务器状态添加 <名称> [上报地址] [备注]（主人私聊；地址需带 http:// 或 https://）"
  if (/服务器状态绑定/.test(value)) return "用法：#服务器状态绑定 <token> 或 #服务器状态绑定 <名称> <token>（主人私聊）"
  if (/服务器状态改名/.test(value)) return "用法：#服务器状态改名 <旧名> <新名>（主人私聊）"
  if (/服务器状态命令/.test(value)) return "用法：#服务器状态命令 <名称>（主人私聊）"
  if (/服务器状态删除|删除服务器/.test(value)) return "用法：#删除服务器 <名称|序号>（主人私聊；无参数会列出服务器）"
  return "用法：#服务器状态帮助 查看全部命令"
}

export function parseDeleteTarget(text) {
  const match = String(text || "").match(/^#?删除服务器\s*[+＋]?\s*(\S+)$/)
  if (!match) return null
  const target = match[1].trim()
  if (!target) return null
  return { target, isIndex: /^\d+$/.test(target) }
}

export function makeAgentCommand({ baseUrl, reportUrl, name, token, interval = 10, path = "/servermonitor/report" }) {
  const url = normalizeReportUrl(reportUrl || baseUrl, path)
  return [
    `node agent.mjs --name ${JSON.stringify(String(name))} --token ${JSON.stringify(String(token))} --report-url ${JSON.stringify(url)} --interval ${JSON.stringify(String(interval))}`,
  ].join(" ")
}

export function buildAddServerReply({ name, note = "", token, reportUrl, command, warning = "" }) {
  return [
    "【服务器添加成功】",
    "",
    `名称：${name}`,
    note ? `备注：${note}` : null,
    `上报地址：${reportUrl}`,
    `专属令牌：${token}`,
    "",
    "请进入服务器的 agent 目录并执行：",
    "",
    command,
    "",
    "启动后发送「#服务器状态」查看上报结果。",
    "",
    `注意：请勿公开专属令牌；上报地址必须能被 ${name} 访问。`,
    warning || null,
  ].filter(line => line !== null).join("\n")
}

export function isLoopbackReportUrl(value) {
  try {
    const host = new URL(String(value || "")).hostname.toLowerCase()
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0"
  } catch {
    return false
  }
}

export function buildServerCommandReply({ name, token, reportUrl, command, warning = "" }) {
  return [
    `【服务器命令】${name}`,
    "",
    `上报地址：${reportUrl}`,
    `专属令牌：${token}`,
    "",
    "在服务器的 agent 目录执行：",
    "",
    command,
    warning ? "" : null,
    warning || null,
  ].filter(line => line !== null).join("\n")
}

export async function buildServerCommand(name, { configuredUrl = "" } = {}) {
  await bootstrap()
  const config = await refreshConfig()
  const conf = resolveConfigServer(name)
  if (!conf) throw new Error(`未找到服务器【${name}】`)
  const base = conf.reportUrl || configuredUrl
  if (!base) throw new Error(`服务器【${conf.name}】没有保存上报地址，请重新执行 #服务器状态添加 <名称> <地址>`)
  const reportUrl = normalizeReportUrl(base)
  const command = makeAgentCommand({ reportUrl, name: conf.name, token: conf.token, interval: 10 })
  const warning = isLoopbackReportUrl(reportUrl)
    ? "当前上报地址是回环地址，远程 agent 无法访问；请重新添加并填写公网/内网地址。"
    : ""
  return { name: conf.name, token: conf.token, reportUrl, command, warning, config }
}

export function sortEntriesByCardLength(entries) {
  return [...(Array.isArray(entries) ? entries : [])]
    .sort((a, b) => (Number(b?.cardRows) || 0) - (Number(a?.cardRows) || 0)
      || String(a?.name || "").localeCompare(String(b?.name || ""), "zh-CN"))
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
