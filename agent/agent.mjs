import si from "systeminformation"
import os from "node:os"
import fs from "node:fs/promises"
import fssync from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createInterface } from "node:readline/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

const execFileAsync = promisify(execFile)
const AGENT_VERSION = "0.1.19"

const THIS_FILE = fileURLToPath(import.meta.url)
const EXE_DIR = process.pkg ? path.dirname(process.execPath) : path.dirname(THIS_FILE)
const CONFIG_FILE = path.join(EXE_DIR, "servermonitor-agent.json")
const WINDOWS_TASK_NAME = "ServerMonitorAgent"

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
  const bin = process.pkg ? "servermonitor-agent.exe" : "node agent.mjs"
  return `usage: ${bin} --name <name> --token <token> [--report-url <url>] [--interval 10] [--slow-interval 30] [--timeout 5000] [--once]
       ${bin} --dry-run [--name <name>]     只采集并打印 JSON，不上报
       ${bin} run                            使用 servermonitor-agent.json 常驻运行
       ${bin}                                Windows 下打开配置菜单

config: servermonitor-agent.json（与 agent.mjs 同目录）
env: SM_NAME, SM_TOKEN, SM_REPORT_URL, SM_INTERVAL, SM_SLOW_INTERVAL, SM_TIMEOUT, SM_DRY_RUN, SM_ONCE`
}

function envValue(name, fallback = "") {
  const value = process.env[name]
  return value === undefined || value === null || value === "" ? fallback : value
}

export function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue
    const text = String(value).trim()
    if (text) return text
  }
  return ""
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

export function pickActiveInterface(list = []) {
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

export function filterDisks(list = []) {
  const badType = /^(tmpfs|devtmpfs|overlay|squashfs|ramfs|efivarfs|autofs|vfat|iso9660)$/i
  const badMount = /^(\/proc|\/sys|\/dev|\/run|\/snap|\/host\/proc|\/host\/sys|\/host\/dev|\/host\/run|\/var\/lib\/docker|\/var\/lib\/containers|\/etc\/(hosts|hostname|resolv\.conf)$)/i
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
      mount: String(item.mount || item.fs || "").trim() === "/host" ? "/" : String(item.mount || item.fs || "").trim() || "?",
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

export async function collectDiskLinuxDf(paths = [], timeout = 5000) {
  const args = ["-kPTx", "squashfs"]
  if (paths.length) args.push("--", ...paths)
  const { stdout } = await execFileAsync("df", args, { timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 })
  const rows = []
  for (const line of String(stdout || "").split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 7) continue
    const totalKb = Number(fields[2])
    const usedKb = Number(fields[3])
    if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb) || totalKb <= 0) continue
    const rawMount = fields.slice(6).join(" ")
    const mount = rawMount === "/host" ? "/" : rawMount.replace(/^\/host(?=\/)/, "")
    rows.push({ mount, type: fields[1], used: usedKb * 1024, size: totalKb * 1024 })
  }
  return filterDisks(rows)
}

const PSEUDO_FS_RE = /^(proc|sysfs|devtmpfs|tmpfs|devpts|cgroup2?|efivarfs|autofs|mqueue|debugfs|tracefs|securityfs|pstore|bpf|configfs|fusectl|hugetlbfs|binfmt_misc|ramfs|nsfs|overlay|squashfs|fuse|fuse\.[\w.]+|rpc_pipefs|selinuxfs)$/i
const SKIP_HOST_MOUNT_RE = /^\/(?:host\/)?(?:proc|sys|dev|run|snap|var\/lib\/docker|var\/lib\/containers)(?:\/|$)/

export function parseHostMounts(text, limit = 16) {
  const rows = []
  const seen = new Set()
  for (const line of String(text || "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) continue
    const [device, mountpoint, fstype] = parts
    if (!mountpoint.startsWith("/")) continue
    if (PSEUDO_FS_RE.test(fstype)) continue
    if (SKIP_HOST_MOUNT_RE.test(mountpoint)) continue
    if (seen.has(device)) continue
    seen.add(device)
    rows.push({ device, mountpoint, fstype })
    if (rows.length >= limit) break
  }
  return rows
}

export function hostMountPaths(mounts) {
  return (Array.isArray(mounts) ? mounts : [])
    .filter(item => !PSEUDO_FS_RE.test(String(item?.fstype || "")))
    .map(item => String(item?.mountpoint || ""))
    .filter(mountpoint => mountpoint.startsWith("/"))
    // /host/proc/mounts 可能给出 /host/xxx，也可能给出宿主机原始路径；统一成容器内可访问路径
    .map(mountpoint => mountpoint === "/" ? "/host" : (mountpoint.startsWith("/host") ? mountpoint : `/host${mountpoint}`))
}

export const HOST_MOUNTS_FILES = ["/host/proc/1/mounts", "/host/proc/mounts", "/proc/self/mounts"]

export async function readHostMountsText(readFile = fs.readFile) {
  for (const file of HOST_MOUNTS_FILES) {
    try {
      const text = await readFile(file, "utf8")
      if (text) return text
    } catch {}
  }
  return ""
}

async function collectDockerHostDisks() {
  if (process.platform !== "linux" || !fssync.existsSync("/host")) return null
  // 三个来源都试一遍：宿主机 PID1 视图最准，容器视图次之；失败时回退到只报根分区
  const mounts = parseHostMounts(await readHostMountsText())
  const paths = [...new Set(hostMountPaths(mounts))].filter(item => {
    try { fssync.accessSync(item); return true } catch { return false }
  })
  if (paths.length <= 1 && paths[0] === "/host") return null
  const rows = await safe(() => collectDiskLinuxDf(paths), null, 8000)
  return Array.isArray(rows) && rows.length ? rows : null
}

export function diskUsageFromStatfs(stats) {
  const bsize = Number(stats?.bsize)
  const blocks = Number(stats?.blocks)
  const bfree = Number(stats?.bfree)
  if (![bsize, blocks, bfree].every(Number.isFinite) || bsize <= 0 || blocks <= 0) return null
  const total = blocks * bsize
  const used = Math.max(0, (blocks - bfree) * bsize)
  return { total, used }
}

export async function collectDisks() {
  if (process.platform === "linux" && fssync.existsSync("/host")) {
    const hostRows = await collectDockerHostDisks()
    if (hostRows) return hostRows
    if (typeof fs.statfs === "function") {
      try {
        const usage = diskUsageFromStatfs(await fs.statfs("/host"))
        if (usage) return [{ mount: "/", used: gb(usage.used), total: gb(usage.total) }]
      } catch {}
    }
  }
  if (process.platform === "linux") {
    const rows = await safe(() => collectDiskLinuxDf(), null, 6000)
    if (Array.isArray(rows)) return rows
  }
  const raw = await safe(() => si.fsSize(), [], 5000)
  return filterDisks(Array.isArray(raw) ? raw : [])
}

export async function collectNetwork() {
  const interfaces = await safe(() => si.networkInterfaces(), [], 5000)
  const names = (Array.isArray(interfaces) ? interfaces : []).map(item => item?.iface).filter(Boolean)
  // systeminformation 只接受逗号分隔字符串；传数组会静默返回空数组
  const stats = await safe(() => si.networkStats(names.length ? names.join(",") : undefined), [], 8000)
  const iface = pickActiveInterface(Array.isArray(stats) ? stats : [])
  if (!iface) return null
  return {
    iface: iface.iface || null,
    rxSec: mb(iface.rx_sec ?? iface.rx_sec_total ?? null),
    txSec: mb(iface.tx_sec ?? iface.tx_sec_total ?? null),
    rxTotal: gb(iface.rx_bytes),
    txTotal: gb(iface.tx_bytes),
  }
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

async function safe(fn, fallback = null, timeout = 5000) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout ${timeout}ms`)), timeout)
        timer.unref?.()
      }),
    ])
  } catch (err) {
    if (/timeout/i.test(String(err?.message || ""))) {
      console.warn(`[servermonitor-agent] collection timeout after ${timeout}ms`)
    }
    return fallback
  } finally {
    clearTimeout(timer)
  }
}

export function parseNvidiaNumber(value) {
  const raw = String(value ?? "").trim().replace(/%$/, "").trim()
  if (!raw || /^\[?n\/a\]?$/i.test(raw)) return null
  const match = raw.match(/^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)/)
  if (!match) return null
  const n = Number(match[0].replace(",", "."))
  return Number.isFinite(n) ? +n.toFixed(1) : null
}

function nvidiaSmiCandidates() {
  if (process.platform === "win32") {
    const root = process.env.SystemRoot || process.env.windir || "C:\\Windows"
    return [path.join(root, "System32", "nvidia-smi.exe"), "nvidia-smi"]
  }
  return ["nvidia-smi"]
}

async function collectGpuFromNvidiaSmi(timeout = 5000) {
  const args = [
    "--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw",
    "--format=csv,noheader,nounits",
  ]
  for (const exe of nvidiaSmiCandidates()) {
    try {
      const { stdout } = await execFileAsync(exe, args, { timeout, windowsHide: true })
      const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean)
      if (!lines.length) continue
      return lines.map(line => {
        // nvidia-smi 使用 ", " 分隔字段；中文区域小数点可能是逗号（如 35,03 W）
        const parts = line.split(/,\s+/).map(i => i.trim())
        const [model, usage, temp, memUsed, memTotal, power] = parts
        return {
          model: model || null,
          usage: clipPercent(parseNvidiaNumber(usage)),
          temp: parseNvidiaNumber(temp),
          memUsed: gibFromMiB(parseNvidiaNumber(memUsed)),
          memTotal: gibFromMiB(parseNvidiaNumber(memTotal)),
          power: parseNvidiaNumber(power),
        }
      })
    } catch {}
  }
  return null
}

export function normalizeVram(value, { windowsAdapterRam = false } = {}) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  if (n === 0) return 0
  // Win32_VideoController.AdapterRAM 是 UInt32：>= 4GiB - 1MiB 一定是截断值，宁可不显示
  if (windowsAdapterRam && n >= 4095) return null
  const gigabytes = +(n / 1024).toFixed(1)
  return gigabytes > 1024 ? null : gigabytes
}

const VIRTUAL_GPU_NAME_RE = /(virtual|virtio|vmware|virtualbox|hyper-v|microsoft basic|gameviewer|mumu|meta virtual|zako|sunshine|parsec|displaylink|usb display|cirrus|qxl|bochs|qemu|standard vga)/i
const REAL_GPU_VENDOR_RE = /(nvidia|amd|radeon|intel|arc)/i

export function isVirtualGpuName(name) {
  const text = String(name || "").trim()
  if (!text) return false
  if (REAL_GPU_VENDOR_RE.test(text)) return false
  return VIRTUAL_GPU_NAME_RE.test(text)
}

export function filterGpuControllers(list = []) {
  return (Array.isArray(list) ? list : []).filter(ctrl => !isVirtualGpuName(ctrl?.model || ctrl?.name))
}

async function collectGpuFromLspci(timeout = 5000) {
  if (process.platform !== "linux") return null
  try {
    const { stdout } = await execFileAsync("lspci", ["-mm"], { timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 })
    const gpus = []
    for (const line of String(stdout || "").split(/\r?\n/)) {
      const match = line.match(/^(\S+)\s+"([^"]*)"\s+"([^"]*)"\s+"([^"]*)"/)
      if (!match || !/(VGA|3D|Display)/i.test(match[2])) continue
      const model = [match[3], match[4]].map(v => v.trim()).filter(Boolean).join(" ").trim()
      if (!model || isVirtualGpuName(model)) continue
      gpus.push({ model, usage: null, temp: null, memUsed: null, memTotal: null, power: null })
    }
    return gpus
  } catch {
    return null
  }
}

async function collectGpuFallback() {
  if (process.platform === "linux") return await collectGpuFromLspci()
  const gfx = await safe(() => si.graphics(), null)
  const ctrls = filterGpuControllers(gfx?.controllers)
  if (!ctrls.length) return []
  const windowsAdapterRam = process.platform === "win32"
  return ctrls.map(ctrl => ({
    model: ctrl.model || ctrl.name || null,
    usage: clipPercent(ctrl.utilizationGpu ?? ctrl.utilization ?? null),
    temp: num(ctrl.temperatureGpu ?? ctrl.temperature ?? null),
    memUsed: normalizeVram(ctrl.memoryUsed ?? ctrl.vramUsed ?? ctrl.vramMemoryUsed ?? null, { windowsAdapterRam }),
    memTotal: normalizeVram(ctrl.vram ?? ctrl.vramTotal ?? ctrl.memoryTotal ?? null, { windowsAdapterRam }),
    power: num(ctrl.powerDraw ?? ctrl.power ?? null),
  }))
}

async function readLinuxCpuTempFromSysfs() {
  const candidates = []
  const readTemp = async file => {
    const raw = await fs.readFile(file, "utf8").catch(() => "")
    const value = Number(String(raw).trim())
    if (!Number.isFinite(value) || value <= 0) return null
    const celsius = value > 1000 ? value / 1000 : value
    return celsius >= -20 && celsius <= 150 ? celsius : null
  }

  const readLabel = async dir => {
    for (const name of ["type", "name", "temp1_label", "temp2_label", "temp3_label"]) {
      const raw = await fs.readFile(path.join(dir, name), "utf8").catch(() => "")
      if (raw.trim()) return raw.trim().toLowerCase()
    }
    return ""
  }

  const hwmonDir = "/sys/class/hwmon"
  const hwmons = await safe(() => fs.readdir(hwmonDir, { withFileTypes: true }), [])
  for (const dirent of hwmons) {
    const dir = path.join(hwmonDir, dirent.name)
    const label = await readLabel(dir)
    const isCpuLike = /coretemp|k10temp|zenpower|cpu_thermal|x86_pkg_temp|cpu/.test(label)
    const entries = await safe(() => fs.readdir(dir), [])
    for (const entry of entries) {
      if (!/^temp\d+_input$/.test(entry)) continue
      const value = await readTemp(path.join(dir, entry))
      if (value === null) continue
      candidates.push({ value, label, isCpuLike })
    }
  }

  const thermalDir = "/sys/class/thermal"
  const zones = await safe(() => fs.readdir(thermalDir, { withFileTypes: true }), [])
  for (const dirent of zones) {
    if (!/^thermal_zone\d+$/.test(dirent.name)) continue
    const dir = path.join(thermalDir, dirent.name)
    const label = await readLabel(dir)
    const isCpuLike = /cpu|coretemp|k10temp|zenpower|x86_pkg_temp/.test(label)
    const value = await readTemp(path.join(dir, "temp"))
    if (value !== null) candidates.push({ value, label, isCpuLike })
  }

  if (!candidates.length) return null
  const cpuLike = candidates.filter(item => item.isCpuLike)
  if (!cpuLike.length) return null
  return Math.max(...cpuLike.map(item => item.value))
}

async function collectCpuTempWindows() {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature | Select-Object -ExpandProperty CurrentTemperature)",
      ],
      { timeout: 3000 },
    )
    const values = String(stdout || "")
      .split(/\r?\n/)
      .map(line => Number(line.trim()))
      .filter(value => Number.isFinite(value) && value > 0)
    const celsius = Math.max(...values) / 10 - 273.15
    return Number.isFinite(celsius) && celsius > -20 && celsius < 150 ? celsius : null
  } catch {
    return null
  }
}

async function collectCpuTemp() {
  const temp = await safe(() => si.cpuTemperature(), null)
  const main = num(temp?.main)
  if (main !== null && main > 0) return main
  const max = num(temp?.max)
  if (max !== null && max > 0) return max
  const cores = Array.isArray(temp?.cores) ? temp.cores.map(num).filter(v => v !== null && v > 0) : []
  if (cores.length) return Math.max(...cores)
  if (process.platform === "linux") return await readLinuxCpuTempFromSysfs()
  if (process.platform === "win32") return await collectCpuTempWindows()
  return null
}

async function collectCpuPowerLinux(raplPrev) {
  if (process.platform !== "linux") return null
  const base = "/sys/class/powercap"
  const dirs = await safe(() => fs.readdir(base, { withFileTypes: true }), [])
  const packages = dirs.filter(dirent => (dirent.isDirectory() || dirent.isSymbolicLink()) && /^(intel|amd)-rapl:\d+$/i.test(dirent.name))
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

export function parseWindowsAvailableMBytes(text) {
  const match = String(text || "").match(/-?\d+(?:[.,]\d+)?/)
  if (!match) return null
  const value = Number(match[0].replace(",", "."))
  return Number.isFinite(value) && value >= 0 ? value : null
}

async function collectWindowsMemAvailableBytes(timeout = 5000) {
  if (process.platform !== "win32") return null
  const script = [
    "$v = $null",
    "try { $v = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop).AvailableMBytes } catch {}",
    "if ($null -eq $v) { try { $v = (Get-Counter '\\Memory\\Available Bytes' -ErrorAction Stop).CounterSamples[0].CookedValue / 1MB } catch {} }",
    "if ($null -ne $v) { [math]::Round([double]$v, 0) }",
  ].join("; ")
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout, windowsHide: true })
    const mib = parseWindowsAvailableMBytes(stdout)
    return mib === null ? null : mib * 1024 * 1024
  } catch {
    return null
  }
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
    this.failCount = 0
    // systeminformation needs two samples before network rates become available
    safe(() => si.networkStats(), [], 5000).catch(() => [])
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
    const [load, mem, net] = await Promise.all([
      safe(() => si.currentLoad(), null),
      safe(() => si.mem(), null),
      collectNetwork(),
    ])
    let availableBytes = mem?.available
    // Windows 下 Node 的 os.freemem() 走 GlobalMemoryStatusEx，语义已是 Available；
    // 仅在缺失/为 0 时用性能计数器兜底，绝不用 total - used 反推。
    if (process.platform === "win32" && (!Number.isFinite(Number(availableBytes)) || Number(availableBytes) <= 0)) {
      const fallbackAvailable = await collectWindowsMemAvailableBytes()
      if (fallbackAvailable !== null) availableBytes = fallbackAvailable
    }
    this.fastCache = {
      load: process.platform === "win32" ? null : formatLoad(os.loadavg()),
      cpuUsage: clipPercent(load?.currentLoad),
      mem: mem
        ? {
            used: gb(mem.used),
            total: gb(mem.total),
            available: gb(availableBytes),
            swapUsed: gb(mem.swapused),
            swapTotal: gb(mem.swaptotal),
          }
        : null,
      net,
    }
    this.lastFastAt = now
    return this.fastCache
  }

  async refreshSlow(force = false) {
    const now = Date.now()
    if (!force && this.slowCache && now - this.lastSlowAt < this.slowInterval) return this.slowCache
    const [disks, temp, gpus] = await Promise.all([
      collectDisks(),
      collectCpuTemp(),
      collectGpuFromNvidiaSmi(),
    ])
    const gpuList = Array.isArray(gpus) && gpus.length ? gpus : await collectGpuFallback()
    this.slowCache = {
      disks,
      cpuTemp: temp,
      gpus: Array.isArray(gpuList) ? gpuList.slice(0, 8) : gpuList,
      cpuPower: await safe(() => collectCpuPowerLinux(this.raplPrev), null, 5000),
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
      gpus: Array.isArray(slowInfo.gpus) ? slowInfo.gpus.slice(0, 8) : slowInfo.gpus,
      mem: fastInfo.mem,
      net: fastInfo.net,
      disks: Array.isArray(slowInfo.disks) ? slowInfo.disks.slice(0, 16) : slowInfo.disks,
      load: fastInfo.load,
    }
  }
}

export async function postSnapshot(url, token, payload, timeout = 5000) {
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
    const text = await resp.text().catch(() => "")
    let data = null
    try { data = text ? JSON.parse(text) : null } catch {}
    if (!resp.ok) throw new Error(`HTTP ${resp.status}${text ? `: ${text.slice(0, 120)}` : ""}`)
    if (!data || data.ok !== true) throw new Error(`invalid response: ${text.slice(0, 120) || "(empty body)"}`)
    return true
  } finally {
    clear()
  }
}

async function loadFileConfig() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf8")
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

async function saveFileConfig(config) {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8")
}

async function promptLine(rl, question, defaultValue = "") {
  const answer = await rl.question(`${question}${defaultValue ? ` [${defaultValue}]` : ""}: `)
  return (answer.trim() || defaultValue).trim()
}

async function promptNumber(rl, question, defaultValue) {
  const raw = await promptLine(rl, question, String(defaultValue))
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : defaultValue
}

async function windowsTaskExists() {
  try {
    await execFileAsync("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME], { windowsHide: true })
    return true
  } catch {
    try {
      await execFileAsync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", WINDOWS_TASK_NAME], { windowsHide: true })
      return true
    } catch {
      return false
    }
  }
}

async function enableWindowsAutostart(target) {
  try {
    await execFileAsync("schtasks", ["/Create", "/TN", WINDOWS_TASK_NAME, "/TR", target, "/SC", "ONSTART", "/RU", "SYSTEM", "/RL", "HIGHEST", "/F"], { windowsHide: true })
    return `系统级开机自启已启用：schtasks /TN ${WINDOWS_TASK_NAME}`
  } catch (taskErr) {
    try {
      await execFileAsync("reg", ["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", WINDOWS_TASK_NAME, "/t", "REG_SZ", "/d", target, "/f"], { windowsHide: true })
      return `当前用户开机自启已启用（无管理员权限，已改用注册表）`
    } catch (regErr) {
      throw new Error(`启用自启失败：${taskErr.message || taskErr} / ${regErr.message || regErr}`)
    }
  }
}

async function disableWindowsAutostart() {
  const messages = []
  try {
    await execFileAsync("schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"], { windowsHide: true })
    messages.push(`系统级自启任务已删除`)
  } catch {}
  try {
    await execFileAsync("reg", ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", WINDOWS_TASK_NAME, "/f"], { windowsHide: true })
    messages.push(`当前用户注册表自启已删除`)
  } catch {}
  return messages.length ? messages.join("；") : "没有发现已启用的开机自启"
}

async function showWindowsMenu() {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    while (true) {
      const config = await loadFileConfig()
      const autostart = await windowsTaskExists()
      console.log(`\n=== ServerMonitor Windows Agent v${AGENT_VERSION} ===`)
      console.log(`配置文件：${CONFIG_FILE}`)
      console.log(`名称：${config.name || "未设置"}`)
      console.log(`上报地址：${config.reportUrl || "未设置"}`)
      console.log(`token：${config.token ? `${String(config.token).slice(0, 6)}...${String(config.token).slice(-6)}` : "未设置"}`)
      console.log(`开机自启：${autostart ? "已启用" : "未启用"}`)
      console.log(`\n  1. 配置名称/token/上报地址`)
      console.log(`  2. 启用开机自启`)
      console.log(`  3. 关闭开机自启`)
      console.log(`  4. 立即测试一次上报`)
      console.log(`  5. 常驻运行（占用当前窗口）`)
      console.log(`  0. 退出`)
      const choice = await rl.question("请选择编号: ")
      const num = Number(choice.trim())

      if (num === 0) return
      if (num === 1) {
        const next = { ...config }
        next.name = await promptLine(rl, "服务器名称", config.name || "win-01")
        next.reportUrl = await promptLine(rl, "上报地址", config.reportUrl || "http://127.0.0.1:2536/servermonitor/report")
        next.token = await promptLine(rl, "上报 token", config.token || "")
        next.interval = await promptNumber(rl, "基础上报间隔秒", Number(config.interval || 10))
        next.slowInterval = await promptNumber(rl, "慢速采集间隔秒", Number(config.slowInterval || next.interval || 30))
        next.timeout = await promptNumber(rl, "上传超时毫秒", Number(config.timeout || 5000))
        await saveFileConfig(next)
        console.log("配置已保存")
      } else if (num === 2) {
        const target = process.pkg
          ? `"${process.execPath}" run`
          : `"${process.execPath}" "${THIS_FILE}" run`
        console.log(await enableWindowsAutostart(target))
      } else if (num === 3) {
        console.log(await disableWindowsAutostart())
      } else if (num === 4) {
        const name = firstNonEmpty(config.name, envValue("SM_NAME"))
        const token = firstNonEmpty(config.token, envValue("SM_TOKEN"))
        const reportUrl = firstNonEmpty(config.reportUrl, envValue("SM_REPORT_URL"))
        if (!name || !token || !reportUrl) {
          console.log("请先完成配置")
          continue
        }
        const collector = new Collector({ slowInterval: Math.max(10, Number(config.slowInterval || 30)) * 1000 })
        collector.name = name
        try {
          const snap = await collector.snapshot()
          await postSnapshot(reportUrl, token, snap, Math.max(1000, Number(config.timeout || 5000)))
          console.log("测试上报成功")
        } catch (err) {
          console.error(`测试上报失败：${err.message || err}`)
        }
      } else if (num === 5) {
        const saved = await loadFileConfig()
        const name = firstNonEmpty(saved.name, envValue("SM_NAME"))
        const token = firstNonEmpty(saved.token, envValue("SM_TOKEN"))
        const reportUrl = firstNonEmpty(saved.reportUrl, envValue("SM_REPORT_URL"))
        if (!name || !token || !reportUrl) {
          console.log("请先完成配置")
          continue
        }
        const collector = new Collector({ slowInterval: Math.max(10, Number(saved.slowInterval || 30)) * 1000 })
        collector.name = name
        while (true) {
          try {
            const snap = await collector.snapshot()
            await postSnapshot(reportUrl, token, snap, Math.max(1000, Number(saved.timeout || 5000)))
            console.log(`[servermonitor-agent] ${name} uploaded @ ${new Date().toISOString()}`)
            await new Promise(resolve => setTimeout(resolve, Math.max(5, Number(saved.interval || 10)) * 1000))
          } catch (err) {
            console.error(`[servermonitor-agent] ${name} upload failed: ${err.message || err}`)
            await new Promise(resolve => setTimeout(resolve, 30000))
          }
        }
      }
    }
  } finally {
    rl.close()
  }
}

async function main() {
  const cliArgv = process.argv.slice(2)
  const args = parseArgs(cliArgv)
  if (args.help) {
    console.log(help())
    process.exit(0)
  }

  if (process.platform === "win32" && cliArgv.length === 0 && process.stdin.isTTY) {
    await showWindowsMenu()
    return
  }

  const fileConfig = await loadFileConfig()

  const dryRun = Boolean(args["dry-run"] || args.dryRun || boolValue(envValue("SM_DRY_RUN")))
  const once = Boolean(args.once || boolValue(envValue("SM_ONCE")))
  const name = firstNonEmpty(args.name, envValue("SM_NAME"), fileConfig.name)
  const token = firstNonEmpty(args.token, envValue("SM_TOKEN"), fileConfig.token)
  const reportUrl = firstNonEmpty(
    args["report-url"],
    args.reportUrl,
    envValue("SM_REPORT_URL"),
    fileConfig.reportUrl,
    "http://127.0.0.1:2536/servermonitor/report",
  )
  const interval = Math.max(5, Number(firstNonEmpty(args.interval, envValue("SM_INTERVAL"), fileConfig.interval) || 10))
  const slowInterval = Math.max(interval, Number(firstNonEmpty(args["slow-interval"], args.slowInterval, envValue("SM_SLOW_INTERVAL"), fileConfig.slowInterval) || 30))
  const timeout = Math.max(1000, Number(firstNonEmpty(args.timeout, envValue("SM_TIMEOUT"), fileConfig.timeout) || 5000))

  if (!name || (!token && !dryRun)) {
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
      if (collector.failCount > 0) {
        console.log(`[servermonitor-agent] ${name} recovered after ${collector.failCount} failed upload(s)`)
        collector.failCount = 0
      }
      console.log(`[servermonitor-agent] ${name} uploaded @ ${new Date().toISOString()}`)
      return true
    } catch (err) {
      collector.failCount += 1
      const cause = err?.cause?.message || err?.cause?.code || err?.cause || ""
      console.error(`[servermonitor-agent] ${name} upload failed (#${collector.failCount}): ${err.message || err}${cause ? ` · cause: ${cause}` : ""}`)
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
    backoff = ok ? interval : Math.min(backoff * 2, Math.max(20, interval * 2))
    await new Promise(resolve => setTimeout(resolve, backoff * 1000))
  }
}

// pkg 打包后 import.meta.url 与 argv[1] 不一致，必须额外识别 process.pkg
const isMainModule = Boolean(process.pkg) || (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
if (isMainModule) {
  await main().catch(err => {
    console.error(`[servermonitor-agent] fatal: ${err.stack || err}`)
    process.exit(1)
  })
}
