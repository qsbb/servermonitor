import si from "systeminformation"
import os from "node:os"
import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const AGENT_VERSION = "0.1.6"

function parseArgs(argv = []) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!key.startsWith("--")) continue
    const next = argv[i + 1]
    if (next && !next.startsWith("--")) {
      out[key.slice(2)] = next
      i++
    } else {
      out[key.slice(2)] = true
    }
  }
  return out
}

function help() {
  return `usage: node agent.mjs --name <name> --token <token> [--report-url <url>] [--interval 10] [--slow-interval 30] [--timeout 5000] [--dry-run] [--once]

env: SM_NAME, SM_TOKEN, SM_REPORT_URL, SM_INTERVAL, SM_SLOW_INTERVAL, SM_TIMEOUT, SM_DRY_RUN, SM_ONCE`
}

function envValue(name, fallback = "") {
  const value = process.env[name]
  return value === undefined || value === null || value === "" ? fallback : value
}

function boolValue(value) {
  if (typeof value === "boolean") return value
  const text = String(value ?? "").trim().toLowerCase()
  return ["1", "true", "yes", "y", "on"].includes(text)
}

function num(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function gb(value, digits = 1) {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return +(n / 1024 ** 3).toFixed(digits)
}

function mb(value, digits = 2) {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return +(n / 1024 ** 2).toFixed(digits)
}

function gibFromMiB(value, digits = 1) {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return +(n / 1024).toFixed(digits)
}

function clipPercent(value) {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, +n.toFixed(1)))
}

function pickActiveInterface(list = []) {
  const bad = /^(lo|docker|veth|br-|virbr|tun|tap|vmnet|vboxnet|utun|awdl|llw)/i
  const candidates = list.filter(item => item?.iface && !bad.test(String(item.iface)))
  const source = candidates.length ? candidates : list
  const sorted = [...source].sort((a, b) => {
    const av = Number(a?.rx_bytes || 0) + Number(a?.tx_bytes || 0)
    const bv = Number(b?.rx_bytes || 0) + Number(b?.tx_bytes || 0)
    return bv - av
  })
  return sorted[0] || null
}

function filterDisks(list = []) {
  const badType = /^(tmpfs|devtmpfs|overlay|squashfs|ramfs|efivarfs|autofs)$/i
  const badMount = /^(\/proc|\/sys|\/dev|\/run|\/snap|\/var\/lib\/docker|\/var\/lib\/containers)/i
  const seen = new Set()
  return list
    .filter(item => item && !badType.test(String(item.type || "")) && !badMount.test(String(item.mount || "")))
    .filter(item => {
      const key = String(item.mount || item.fs || "")
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map(item => ({
      mount: String(item.mount || item.fs || "").trim() || "?",
      used: gb(item.used),
      total: gb(item.size ?? item.total),
    }))
    .filter(item => item.total !== null)
    .sort((a, b) => {
      if (a.mount === "/" || /^C:([\\/])?$/i.test(a.mount)) return -1
      if (b.mount === "/" || /^C:([\\/])?$/i.test(b.mount)) return 1
      return (Number(b.used) / Number(b.total)) - (Number(a.used) / Number(a.total))
    })
    .slice(0, 8)
}

function formatLoad(load) {
  if (!Array.isArray(load) || !load.length) return null
  const arr = load.filter(i => Number.isFinite(Number(i))).slice(0, 3).map(i => +Number(i).toFixed(2))
  return arr.length ? arr : null
}

function timeoutSignal(ms = 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timeout ${ms}ms`)), ms)
  timer.unref?.()
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer)
    },
  }
}

async function safe(fn, fallback = null) {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

async function collectGpuFromNvidiaSmi(timeout = 5000) {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      [
        "--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw",
        "--format=csv,noheader,nounits",
      ],
      { timeout },
    )
    const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean)
    const gpus = lines.map(line => {
      const parts = line.split(",").map(i => i.trim())
      const [model, usage, temp, memUsed, memTotal, power] = parts
      return {
        model: model || null,
        usage: clipPercent(usage),
        temp: num(temp),
        memUsed: gibFromMiB(memUsed),
        memTotal: gibFromMiB(memTotal),
        power: num(power),
      }
    })
    return gpus
  } catch {
    return null
  }
}

function normalizeVram(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  if (n === 0) return 0
  if (n > 1024 * 1024 * 1024) return +(n / 1024 ** 3).toFixed(1)
  if (n > 1024 * 1024) return +(n / 1024 ** 2).toFixed(1)
  if (n > 1024) return +(n / 1024).toFixed(1)
  return +n.toFixed(1)
}

async function collectGpuFallback() {
  const gfx = await safe(() => si.graphics(), null)
  const ctrls = Array.isArray(gfx?.controllers) ? gfx.controllers : []
  if (!ctrls.length) return []
  return ctrls.map(ctrl => ({
    model: ctrl.model || null,
    usage: null,
    temp: null,
    memUsed: normalizeVram(ctrl.vramUsed ?? ctrl.vramMemoryUsed ?? null),
    memTotal: normalizeVram(ctrl.vram ?? ctrl.vramTotal ?? null),
    power: null,
  }))
}

async function collectCpuTemp() {
  const temp = await safe(() => si.cpuTemperature(), null)
  const main = num(temp?.main)
  if (main !== null && main > 0) return main
  const max = num(temp?.max)
  if (max !== null && max > 0) return max
  const cores = Array.isArray(temp?.cores) ? temp.cores.map(num).filter(v => v !== null && v > 0) : []
  if (cores.length) return Math.max(...cores)
  return null
}

async function collectCpuPowerLinux(raplPrev) {
  if (process.platform !== "linux") return null
  const base = "/sys/class/powercap"
  const dirs = await safe(() => fs.readdir(base, { withFileTypes: true }), [])
  const packages = dirs.filter(dirent => dirent.isDirectory() && /^intel-rapl:\d+$/.test(dirent.name))
  if (!packages.length) return null

  let total = 0
  let count = 0
  for (const dirent of packages) {
    const energyPath = path.join(base, dirent.name, "energy_uj")
    const rangePath = path.join(base, dirent.name, "max_energy_range_uj")
    try {
      const [energyRaw, rangeRaw] = await Promise.all([
        fs.readFile(energyPath, "utf8"),
        fs.readFile(rangePath, "utf8").catch(() => ""),
      ])
      const energy = Number(String(energyRaw).trim())
      const range = Number(String(rangeRaw).trim()) || 0
      if (!Number.isFinite(energy)) continue
      const now = Date.now()
      const prev = raplPrev.get(energyPath)
      raplPrev.set(energyPath, { energy, ts: now, range })
      if (!prev) continue
      let delta = energy - prev.energy
      if (delta < 0 && prev.range) delta += prev.range
      const dt = (now - prev.ts) / 1000
      if (!(dt > 0)) continue
      total += delta / 1e6 / dt
      count++
    } catch {
      continue
    }
  }
  if (!count) return null
  return +total.toFixed(1)
}

class Collector {
  constructor({ slowInterval = 30_000 } = {}) {
    this.slowInterval = Math.max(5_000, slowInterval)
    this.staticCache = null
    this.fastCache = null
    this.slowCache = null
    this.lastStaticAt = 0
    this.lastFastAt = 0
    this.lastSlowAt = 0
    this.raplPrev = new Map()
  }

  async refreshStatic(force = false) {
    const now = Date.now()
    if (!force && this.staticCache && now - this.lastStaticAt < 60 * 60 * 1000) return this.staticCache
    const [cpu, osInfo] = await Promise.all([
      safe(() => si.cpu(), null),
      safe(() => si.osInfo(), null),
    ])
    this.staticCache = {
      cpu: {
        model: cpu?.brand || cpu?.manufacturer || os.cpus()?.[0]?.model || null,
        cores: cpu?.cores ?? os.cpus().length,
      },
      os: {
        platform: os.platform(),
        distro: osInfo?.distro || null,
        release: osInfo?.release || os.release(),
        arch: os.arch(),
        hostname: os.hostname(),
      },
    }
    this.lastStaticAt = now
    return this.staticCache
  }

  async refreshFast(force = false) {
    const now = Date.now()
    if (!force && this.fastCache && now - this.lastFastAt < 3_000) return this.fastCache
    const [load, mem, netStats] = await Promise.all([
      safe(() => si.currentLoad(), null),
      safe(() => si.mem(), null),
      safe(() => si.networkStats(), []),
    ])
    const iface = pickActiveInterface(netStats)
    this.fastCache = {
      load: process.platform === "win32" ? null : formatLoad(os.loadavg()),
      cpuUsage: clipPercent(load?.currentLoad),
      mem: mem
        ? {
            used: gb(mem.used),
            total: gb(mem.total),
            swapUsed: gb(mem.swapused),
            swapTotal: gb(mem.swaptotal),
          }
        : null,
      net: iface
        ? {
            iface: iface.iface || null,
            rxSec: mb(iface.rx_sec ?? iface.rx_sec_total ?? null),
            txSec: mb(iface.tx_sec ?? iface.tx_sec_total ?? null),
            rxTotal: gb(iface.rx_bytes),
            txTotal: gb(iface.tx_bytes),
          }
        : null,
    }
    this.lastFastAt = now
    return this.fastCache
  }

  async refreshSlow(force = false) {
    const now = Date.now()
    if (!force && this.slowCache && now - this.lastSlowAt < this.slowInterval) return this.slowCache
    const [disks, temp, gpus] = await Promise.all([
      safe(() => si.fsSize(), []),
      collectCpuTemp(),
      collectGpuFromNvidiaSmi(),
    ])
    const gpuList = Array.isArray(gpus) && gpus.length ? gpus : await collectGpuFallback()
    this.slowCache = {
      disks: filterDisks(disks),
      cpuTemp: temp,
      gpus: gpuList,
      cpuPower: await collectCpuPowerLinux(this.raplPrev),
    }
    this.lastSlowAt = now
    return this.slowCache
  }

  async snapshot() {
    const [staticInfo, fastInfo, slowInfo] = await Promise.all([
      this.refreshStatic(),
      this.refreshFast(),
      this.refreshSlow(),
    ])

    return {
      v: 1,
      name: this.name,
      agent_ts: Date.now(),
      os: {
        ...staticInfo.os,
        uptime: os.uptime(),
      },
      cpu: {
        model: staticInfo.cpu.model,
        cores: staticInfo.cpu.cores,
        usage: fastInfo.cpuUsage,
        temp: slowInfo.cpuTemp,
        power: slowInfo.cpuPower,
      },
      gpus: slowInfo.gpus,
      mem: fastInfo.mem,
      net: fastInfo.net,
      disks: slowInfo.disks,
      load: fastInfo.load,
    }
  }
}

async function postSnapshot(url, token, payload, timeout = 5000) {
  const { signal, clear } = timeoutSignal(timeout)
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SM-Token": token,
        "User-Agent": `servermonitor-agent/${AGENT_VERSION}`,
      },
      body: JSON.stringify(payload),
      signal,
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return true
  } finally {
    clear()
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(help())
    process.exit(0)
  }

  const name = String(args.name || envValue("SM_NAME")).trim()
  const token = String(args.token || envValue("SM_TOKEN")).trim()
  const reportUrl = String(args["report-url"] || args.reportUrl || envValue("SM_REPORT_URL", "http://127.0.0.1:2536/servermonitor/report")).trim()
  const interval = Math.max(5, Number(args.interval || envValue("SM_INTERVAL")) || 10)
  const slowInterval = Math.max(interval, Number(args["slow-interval"] || args.slowInterval || envValue("SM_SLOW_INTERVAL")) || 30)
  const timeout = Math.max(1000, Number(args.timeout || envValue("SM_TIMEOUT")) || 5000)
  const dryRun = Boolean(args["dry-run"] || args.dryRun || boolValue(envValue("SM_DRY_RUN")))
  const once = Boolean(args.once || boolValue(envValue("SM_ONCE")))

  if (!name || !token) {
    console.error(help())
    process.exit(1)
  }

  const collector = new Collector({ slowInterval: slowInterval * 1000 })
  collector.name = name

  async function tick() {
    const snap = await collector.snapshot()
    if (dryRun) {
      console.log(JSON.stringify(snap, null, 2))
      return true
    }
    try {
      await postSnapshot(reportUrl, token, snap, timeout)
      console.log(`[servermonitor-agent] ${name} uploaded @ ${new Date().toISOString()}`)
      return true
    } catch (err) {
      console.error(`[servermonitor-agent] ${name} upload failed: ${err.message || err}`)
      return false
    }
  }

  if (dryRun) {
    await tick()
    return
  }

  if (once) {
    const ok = await tick()
    process.exit(ok ? 0 : 1)
  }

  let backoff = interval
  while (true) {
    const ok = await tick()
    backoff = ok ? interval : Math.min(backoff * 2, 60)
    await new Promise(resolve => setTimeout(resolve, backoff * 1000))
  }
}

await main().catch(err => {
  console.error(`[servermonitor-agent] fatal: ${err.stack || err}`)
  process.exit(1)
})
