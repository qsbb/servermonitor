import os from "node:os"
import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const raplState = globalThis.__servermonitorLocalRaplState ??= new Map()

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function num(value) {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clipPercent(value) {
  const n = num(value)
  if (n === null) return null
  return Math.max(0, Math.min(100, +n.toFixed(1)))
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

function gb(value, digits = 1) {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return +(n / 1024 ** 3).toFixed(digits)
}

async function safe(fn, fallback = null) {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

function parseCpuSnapshot(cpus = os.cpus()) {
  const aggregate = cpus.reduce((acc, cpu) => {
    const t = cpu.times || {}
    const idle = Number(t.idle || 0)
    const total = Object.values(t).reduce((sum, v) => sum + Number(v || 0), 0)
    acc.idle += idle
    acc.total += total
    return acc
  }, { idle: 0, total: 0 })
  return aggregate
}

async function sampleCpuUsage(delayMs = 200) {
  const start = parseCpuSnapshot()
  await sleep(delayMs)
  const end = parseCpuSnapshot()
  const idle = end.idle - start.idle
  const total = end.total - start.total
  if (!(total > 0)) return null
  return clipPercent((1 - idle / total) * 100)
}

async function collectCpuTempLinux() {
  if (process.platform !== "linux") return null
  const base = "/sys/class/thermal"
  const entries = await safe(() => fs.readdir(base, { withFileTypes: true }), [])
  const zones = entries.filter(item => item.isDirectory() && item.name.startsWith("thermal_zone"))
  let maxTemp = null
  for (const zone of zones) {
    const tempPath = path.join(base, zone.name, "temp")
    const typePath = path.join(base, zone.name, "type")
    const [tempRaw, typeRaw] = await Promise.all([
      fs.readFile(tempPath, "utf8").catch(() => ""),
      fs.readFile(typePath, "utf8").catch(() => ""),
    ])
    const temp = Number(String(tempRaw).trim())
    if (!Number.isFinite(temp) || temp <= 0) continue
    const name = String(typeRaw).trim().toLowerCase()
    if (name && !/(cpu|package|x86|core|soc)/i.test(name)) continue
    const value = temp > 1000 ? temp / 1000 : temp
    maxTemp = maxTemp === null ? value : Math.max(maxTemp, value)
  }
  return maxTemp === null ? null : +maxTemp.toFixed(1)
}

async function collectGpuNvidiaSmi() {
  const result = await safe(() => execFileAsync(
    "nvidia-smi",
    [
      "--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw",
      "--format=csv,noheader,nounits",
    ],
    { timeout: 5000 },
  ), null)
  const stdout = String(result?.stdout || "").trim()
  if (!stdout) return null
  const lines = stdout.split(/\r?\n/).filter(Boolean)
  if (!lines.length) return null
  return lines.map(line => {
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
}

async function collectGpuModelFallback() {
  if (process.platform === "linux") {
    const result = await safe(() => execFileAsync("lspci", ["-mm"], { timeout: 5000 }), null)
    const stdout = String(result?.stdout || "")
    const models = stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => /"(VGA compatible controller|3D controller|Display controller)"/i.test(line))
      .map(line => {
        const fields = [...line.matchAll(/"([^"]*)"/g)].map(match => match[1])
        return fields[2] || fields[1] || fields[0] || null
      })
      .filter(Boolean)
    return models.map(model => ({
      model,
      usage: null,
      temp: null,
      memUsed: null,
      memTotal: null,
      power: null,
    }))
  }

  if (process.platform === "win32") {
    const result = await safe(() => execFileAsync("wmic", ["path", "win32_VideoController", "get", "Name", "/format:csv"], { timeout: 5000 }), null)
    const stdout = String(result?.stdout || "")
    const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const models = lines
      .filter(line => !/^Node,Name$/i.test(line))
      .map(line => line.split(",").pop()?.trim())
      .filter(Boolean)
    return models.map(model => ({
      model,
      usage: null,
      temp: null,
      memUsed: null,
      memTotal: null,
      power: null,
    }))
  }

  return []
}

async function collectGpu() {
  const nvidia = await collectGpuNvidiaSmi()
  if (Array.isArray(nvidia) && nvidia.length) return nvidia
  return await collectGpuModelFallback()
}

async function collectCpuPowerLinux() {
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
      const prev = raplState.get(energyPath)
      raplState.set(energyPath, { energy, ts: now, range })
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

async function readLinuxNetTotals() {
  const raw = await fs.readFile("/proc/net/dev", "utf8")
  return raw
    .split(/\r?\n/)
    .slice(2)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [ifacePart, dataPart] = line.split(":")
      if (!dataPart) return null
      const fields = dataPart.trim().split(/\s+/)
      const iface = ifacePart.trim()
      const rxBytes = Number(fields[0] || 0)
      const txBytes = Number(fields[8] || 0)
      return { iface, rxBytes, txBytes }
    })
    .filter(Boolean)
}

async function collectLinuxNet() {
  const first = await readLinuxNetTotals()
  await sleep(200)
  const second = await readLinuxNetTotals()
  const map = new Map(first.map(item => [item.iface, item]))
  const candidates = second.filter(item => item.iface !== "lo")
  const active = candidates.sort((a, b) => (b.rxBytes + b.txBytes) - (a.rxBytes + a.txBytes))[0] || second[0] || null
  if (!active) return null
  const prev = map.get(active.iface) || { rxBytes: active.rxBytes, txBytes: active.txBytes }
  const deltaRx = Math.max(0, active.rxBytes - prev.rxBytes)
  const deltaTx = Math.max(0, active.txBytes - prev.txBytes)
  return {
    iface: active.iface,
    rxSec: +(deltaRx / 1024 / 1024 / 0.2).toFixed(2),
    txSec: +(deltaTx / 1024 / 1024 / 0.2).toFixed(2),
    rxTotal: gb(active.rxBytes),
    txTotal: gb(active.txBytes),
  }
}

async function collectNetwork() {
  if (process.platform === "linux") return await collectLinuxNet()
  return null
}

async function collectDisk() {
  if (process.platform === "linux" || process.platform === "darwin") {
    const result = await safe(() => execFileAsync("df", ["-kP", "/"], { timeout: 5000 }), null)
    const stdout = String(result?.stdout || "")
    const line = stdout.split(/\r?\n/).slice(1).find(Boolean)
    if (!line) return []
    const parts = line.trim().split(/\s+/)
    if (parts.length < 6) return []
    const totalKb = Number(parts[1])
    const usedKb = Number(parts[2])
    const mount = parts[5]
    return [{
      mount,
      used: +(usedKb / 1024 / 1024).toFixed(1),
      total: +(totalKb / 1024 / 1024).toFixed(1),
    }]
  }

  if (process.platform === "win32") {
    const result = await safe(() => execFileAsync("wmic", ["logicaldisk", "get", "Caption,FreeSpace,Size", "/format:csv"], { timeout: 5000 }), null)
    const stdout = String(result?.stdout || "")
    const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const rows = []
    for (const line of lines) {
      if (/^Node,Caption,FreeSpace,Size$/i.test(line)) continue
      const parts = line.split(",").map(i => i.trim())
      if (parts.length < 4) continue
      const mount = parts[1]
      const free = Number(parts[2])
      const size = Number(parts[3])
      if (!Number.isFinite(size) || size <= 0) continue
      rows.push({
        mount,
        used: +((size - free) / 1024 / 1024 / 1024).toFixed(1),
        total: +(size / 1024 / 1024 / 1024).toFixed(1),
      })
    }
    return rows.slice(0, 8)
  }

  return []
}

async function collectLoad() {
  return process.platform === "win32" ? null : os.loadavg().slice(0, 3).map(i => +Number(i).toFixed(2))
}

async function collectSnapshot() {
  const [cpuUsage, cpuTemp, gpus, cpuPower, net, disks, load] = await Promise.all([
    sampleCpuUsage(),
    collectCpuTempLinux(),
    collectGpu(),
    collectCpuPowerLinux(),
    collectNetwork(),
    collectDisk(),
    collectLoad(),
  ])

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
      usage: cpuUsage,
      temp: cpuTemp,
      power: cpuPower,
    },
    gpus,
    mem: {
      used: +( (os.totalmem() - os.freemem()) / 1024 ** 3 ).toFixed(1),
      total: +(os.totalmem() / 1024 ** 3).toFixed(1),
      swapUsed: null,
      swapTotal: null,
    },
    net,
    disks,
    load,
  }
}

export async function collectLocalSnapshot() {
  return await collectSnapshot()
}
