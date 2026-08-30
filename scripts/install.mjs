#!/usr/bin/env node
import fs from "node:fs/promises"
import fssync from "node:fs"
import os from "node:os"
import crypto from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"

const REPO_URL_INPUT = process.env.REPO_URL || ""
const DEFAULT_REPO_URL = "https://github.com/qsbb/servermonitor.git"
const REPO_MIRRORS = process.env.REPO_MIRRORS || [
  "https://github.com/qsbb/servermonitor.git",
  "https://ghfast.top/https://github.com/qsbb/servermonitor.git",
  "https://gh-proxy.com/https://github.com/qsbb/servermonitor.git",
  "https://gitclone.com/github.com/qsbb/servermonitor.git",
  "https://mirror.ghproxy.com/https://github.com/qsbb/servermonitor.git",
].join(",")
const AUTO_GIT_MIRROR = process.env.AUTO_GIT_MIRROR !== "0" && process.env.AUTO_GIT_MIRROR !== "false"
const GIT_MIRROR_PROBE_TIMEOUT = Number(process.env.GIT_MIRROR_PROBE_TIMEOUT || 5)
const BRANCH = process.env.BRANCH || "main"
let REPO_URL = DEFAULT_REPO_URL
const RAW_BASE = process.env.SM_INSTALL_BASE || "https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts"
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const isWin = process.platform === "win32"
const isMac = process.platform === "darwin"
const isLinux = process.platform === "linux"

function title(text) {
  console.log(`\n=== ${text} ===`)
}

function makeToken() {
  return `sm_${crypto.randomBytes(16).toString("hex")}`
}

function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false, ...options })
    child.on("error", reject)
    child.on("exit", code => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`))
    })
  })
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function probeGitMirror(url) {
  return new Promise(resolve => {
    const start = Date.now()
    const child = spawn("git", ["ls-remote", "--heads", url, BRANCH], { stdio: "ignore" })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve(null)
    }, GIT_MIRROR_PROBE_TIMEOUT * 1000)
    child.on("error", () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on("exit", code => {
      clearTimeout(timer)
      resolve(code === 0 ? Date.now() - start : null)
    })
  })
}

async function selectRepoUrl() {
  if (REPO_URL_INPUT) {
    REPO_URL = REPO_URL_INPUT
    console.log(`[servermonitor] using configured REPO_URL=${REPO_URL}`)
    return
  }
  if (!AUTO_GIT_MIRROR) {
    REPO_URL = DEFAULT_REPO_URL
    console.log(`[servermonitor] auto git mirror disabled, using REPO_URL=${REPO_URL}`)
    return
  }

  let best = ""
  let bestMs = Number.POSITIVE_INFINITY
  for (const raw of REPO_MIRRORS.split(",")) {
    const candidate = raw.trim()
    if (!candidate) continue
    console.log(`[servermonitor] testing git mirror: ${candidate}`)
    const ms = await probeGitMirror(candidate)
    if (ms == null) {
      console.log(`[servermonitor] git mirror failed/timeout: ${candidate}`)
      continue
    }
    console.log(`[servermonitor] git mirror ok: ${candidate} (${ms}ms)`)
    if (ms < bestMs) {
      best = candidate
      bestMs = ms
    }
  }

  REPO_URL = best || DEFAULT_REPO_URL
  if (!best) console.log(`[servermonitor] all git mirror probes failed, fallback REPO_URL=${REPO_URL}`)
  console.log(`[servermonitor] selected REPO_URL=${REPO_URL}`)
}

function commandExists(command) {
  return new Promise(resolve => {
    const child = isWin
      ? spawn("where", [command], { stdio: "ignore", shell: true })
      : spawn("sh", ["-c", `command -v ${shellQuote(command)} >/dev/null 2>&1`], { stdio: "ignore" })
    child.on("error", () => resolve(false))
    child.on("exit", code => resolve(code === 0))
  })
}

async function requireCommand(command, hint = "") {
  if (await commandExists(command)) return
  throw new Error(`${command} is required${hint ? `: ${hint}` : ""}`)
}

async function prompt(rl, question, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : ""
  const answer = await rl.question(`${question}${suffix}: `)
  return (answer.trim() || defaultValue).trim()
}

async function choose(rl, question, choices, defaultIndex = 0) {
  console.log(`\n${question}`)
  choices.forEach((item, idx) => console.log(`  ${idx + 1}. ${item}`))
  const answer = await prompt(rl, "请选择编号", String(defaultIndex + 1))
  const index = Number(answer) - 1
  if (!Number.isInteger(index) || index < 0 || index >= choices.length) return defaultIndex
  return index
}

function defaultAgentMode() {
  if (isWin) return "windows"
  if (isMac) return "macos"
  return "linux-systemd"
}

async function buildReportUrl(rl) {
  const full = await prompt(rl, "直接输入完整上报 URL，留空则按 IP+端口生成", "")
  if (full) return full

  const protocol = await prompt(rl, "Yunzai 协议 http/https", "http")
  const host = await prompt(rl, "Yunzai 机器 IP/域名", "192.168.1.10")
  const port = await prompt(rl, "Yunzai HTTP 端口", "2536")
  const route = await prompt(rl, "servermonitor 上报路径", "/servermonitor/report")
  const normalizedRoute = route.startsWith("/") ? route : `/${route}`
  return `${protocol}://${host}:${port}${normalizedRoute}`
}

async function localOrDownloadedScript(name) {
  const local = path.join(SCRIPT_DIR, name)
  if (fssync.existsSync(local)) return local

  if (typeof fetch !== "function") throw new Error("Node.js 18+ is required for remote installer download")
  const url = `${RAW_BASE}/${name}`
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`download failed: ${url} HTTP ${resp.status}`)
  const content = await resp.text()
  const target = path.join(os.tmpdir(), `servermonitor-${Date.now()}-${name}`)
  await fs.writeFile(target, content, "utf8")
  if (!isWin) await fs.chmod(target, 0o755)
  return target
}

async function installPlugin(rl) {
  title("安装 Yunzai 插件")
  await requireCommand("git", "install git first")
  await selectRepoUrl()
  const yunzaiDir = await prompt(rl, "TRSS-Yunzai 根目录", process.env.YUNZAI_DIR || "/path/to/Yunzai")
  const pluginDir = path.join(yunzaiDir, "plugins", "servermonitor")
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "servermonitor-plugin-"))
  const cloned = path.join(tmp, "servermonitor")

  await run("git", ["clone", "--depth", "1", "--branch", BRANCH, REPO_URL, cloned])
  await fs.mkdir(path.dirname(pluginDir), { recursive: true })

  const oldConfig = path.join(pluginDir, "config.yaml")
  const oldData = path.join(pluginDir, "data")
  const backupConfig = path.join(tmp, "config.yaml")
  const backupData = path.join(tmp, "data")

  if (fssync.existsSync(oldConfig)) await fs.copyFile(oldConfig, backupConfig)
  if (fssync.existsSync(oldData)) await fs.cp(oldData, backupData, { recursive: true })

  await fs.rm(pluginDir, { recursive: true, force: true })
  await fs.cp(cloned, pluginDir, { recursive: true })

  if (fssync.existsSync(backupConfig)) await fs.copyFile(backupConfig, path.join(pluginDir, "config.yaml"))
  if (fssync.existsSync(backupData)) {
    await fs.rm(path.join(pluginDir, "data"), { recursive: true, force: true })
    await fs.cp(backupData, path.join(pluginDir, "data"), { recursive: true })
  }
  await fs.mkdir(path.join(pluginDir, "data"), { recursive: true })

  const entry = path.join(pluginDir, "index.js")
  if (!fssync.existsSync(entry)) throw new Error(`entry missing: ${entry}`)

  console.log(`\n安装完成：${pluginDir}`)
  console.log(`入口文件：${entry}`)
  console.log("重启 TRSS-Yunzai 后发送：#服务器状态检查")
}

async function runCapture(command, args, timeoutMs = 3000) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] })
    let out = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve(out)
    }, timeoutMs)
    child.stdout.on("data", chunk => { out += String(chunk) })
    child.on("error", () => {
      clearTimeout(timer)
      resolve(out)
    })
    child.on("exit", () => {
      clearTimeout(timer)
      resolve(out)
    })
  })
}

function parseKeyValueText(text) {
  const values = {}
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (match) values[match[1]] = match[2].trim()
  }
  return values
}

function parseSystemdEnvironment(text) {
  const values = {}
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*Environment=([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (match) values[match[1]] = match[2].trim()
  }
  return values
}

function parsePlistEnvironment(text) {
  const values = {}
  const source = String(text || "")
  for (const key of ["SM_NAME", "SM_TOKEN", "SM_REPORT_URL", "SM_INTERVAL", "SM_SLOW_INTERVAL", "SM_TIMEOUT"]) {
    const match = source.match(new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`))
    if (match) values[key] = match[1].trim()
  }
  return values
}

async function detectExistingAgent(mode) {
  if (mode === "linux-systemd") {
    const serviceFile = "/etc/systemd/system/servermonitor-agent.service"
    const installDir = process.env.INSTALL_DIR || "/opt/servermonitor/agent"
    if (!fssync.existsSync(serviceFile) || !fssync.existsSync(path.join(installDir, "agent.mjs"))) return null
    try {
      const env = parseSystemdEnvironment(await fs.readFile(serviceFile, "utf8"))
      return { kind: "Linux systemd", installDir, values: env }
    } catch { return null }
  }

  if (mode === "linux-docker") {
    const installDir = process.env.INSTALL_DIR || "/opt/servermonitor-docker"
    if (!fssync.existsSync(path.join(installDir, ".env")) || !fssync.existsSync(path.join(installDir, "docker-compose.agent.yml"))) return null
    try {
      const env = parseKeyValueText(await fs.readFile(path.join(installDir, ".env"), "utf8"))
      return { kind: "Linux Docker Compose", installDir, values: env }
    } catch { return null }
  }

  if (mode === "macos") {
    const plist = "/Library/LaunchDaemons/com.servermonitor.agent.plist"
    const installDir = process.env.INSTALL_DIR || "/opt/servermonitor/agent"
    if (!fssync.existsSync(plist) || !fssync.existsSync(path.join(installDir, "agent.mjs"))) return null
    try {
      const env = parsePlistEnvironment(await fs.readFile(plist, "utf8"))
      return { kind: "macOS launchd", installDir, values: env }
    } catch { return null }
  }

  if (mode === "windows") {
    const installDir = process.env.INSTALL_DIR || "C:\\servermonitor\\agent"
    const serviceName = process.env.SERVICE_NAME || "servermonitor-agent"
    if (!fssync.existsSync(path.join(installDir, "agent.mjs"))) return null
    const nssm = await commandExists("nssm") ? "nssm" : null
    if (!nssm) return null
    try {
      const raw = await runCapture(nssm, ["get", serviceName, "AppEnvironmentExtra"], 3000)
      const env = parseKeyValueText(raw)
      return { kind: "Windows NSSM", installDir, values: env }
    } catch { return null }
  }

  return null
}

function maskToken(value) {
  const token = String(value || "")
  if (!token) return ""
  if (token.length <= 10) return token
  return `${token.slice(0, 6)}...${token.slice(-6)}`
}

async function installAgent(mode, rl) {
  title("安装服务器 agent")
  const existing = await detectExistingAgent(mode)

  if (existing) {
    const values = existing.values || {}
    console.log(`检测到已有安装：${existing.kind} · ${existing.installDir}`)
    if (values.SM_NAME) console.log(`名称：${values.SM_NAME}`)
    if (values.SM_REPORT_URL) console.log(`上报地址：${values.SM_REPORT_URL}`)
    if (values.SM_TOKEN) console.log(`token：${maskToken(values.SM_TOKEN)}`)

    const updateChoice = await choose(rl, "如何处理已有安装", ["更新并保留现有配置（推荐）", "重新配置"], 0)
    console.log("\n端口说明：servermonitor 复用 TRSS-Yunzai 的 HTTP 服务端口，只新增 /servermonitor/report 路径。")

    if (updateChoice === 0) {
      if (mode === "linux-systemd") {
        const script = await localOrDownloadedScript("install-agent-linux.sh")
        const cmd = process.getuid?.() === 0 ? "bash" : "sudo"
        const args = process.getuid?.() === 0 ? [script] : ["bash", script]
        await run(cmd, args)
        return
      }
      if (mode === "linux-docker") {
        const script = await localOrDownloadedScript("install-agent-docker.sh")
        const cmd = process.getuid?.() === 0 ? "bash" : "sudo"
        const args = process.getuid?.() === 0 ? [script] : ["bash", script]
        await run(cmd, args)
        return
      }
      if (mode === "macos") {
        const script = await localOrDownloadedScript("install-agent-macos.sh")
        const cmd = process.getuid?.() === 0 ? "bash" : "sudo"
        const args = process.getuid?.() === 0 ? [script] : ["bash", script]
        await run(cmd, args)
        return
      }
      if (mode === "windows") {
        const script = await localOrDownloadedScript("install-agent-windows.ps1")
        await run("powershell", ["-ExecutionPolicy", "Bypass", "-File", script])
        return
      }
    }
  }

  const name = await prompt(rl, "服务器名称", process.env.SM_NAME || (isWin ? "win-01" : isMac ? "mac-01" : "web-01"))
  let token = await prompt(rl, "上报 token（留空则在本机生成，之后到 Yunzai 私聊绑定）", process.env.SM_TOKEN || "")
  if (!token) {
    token = makeToken()
    console.log(`已生成本机 token：${token}`)
    console.log(`等待一次上传日志后，在 Yunzai 私聊发送：#服务器状态绑定 ${token}`)
  }
  const reportUrl = await buildReportUrl(rl)

  console.log("\n端口说明：servermonitor 复用 TRSS-Yunzai 的 HTTP 服务端口，只新增 /servermonitor/report 路径。")
  console.log("如果你的 OneBotV11 也在 2536 上，它们属于同一个 HTTP 服务的不同路径，不是两个程序抢同一个端口。")

  if (mode === "linux-systemd") {
    const script = await localOrDownloadedScript("install-agent-linux.sh")
    const cmd = process.getuid?.() === 0 ? "bash" : "sudo"
    const args = process.getuid?.() === 0 ? [script, name, token, reportUrl] : ["bash", script, name, token, reportUrl]
    await run(cmd, args)
    return
  }

  if (mode === "linux-docker") {
    const script = await localOrDownloadedScript("install-agent-docker.sh")
    const cmd = process.getuid?.() === 0 ? "bash" : "sudo"
    const args = process.getuid?.() === 0 ? [script, name, token, reportUrl] : ["bash", script, name, token, reportUrl]
    await run(cmd, args)
    return
  }

  if (mode === "macos") {
    const script = await localOrDownloadedScript("install-agent-macos.sh")
    const cmd = process.getuid?.() === 0 ? "bash" : "sudo"
    const args = process.getuid?.() === 0 ? [script, name, token, reportUrl] : ["bash", script, name, token, reportUrl]
    await run(cmd, args)
    return
  }

  if (mode === "windows") {
    const script = await localOrDownloadedScript("install-agent-windows.ps1")
    const ps = "powershell"
    await run(ps, [
      "-ExecutionPolicy", "Bypass",
      "-File", script,
      "-Name", name,
      "-Token", token,
      "-ReportUrl", reportUrl,
    ])
    return
  }

  throw new Error(`unknown mode: ${mode}`)
}

async function printCommands(mode, rl) {
  title("生成命令")
  if (mode === "plugin") {
    const yunzaiDir = await prompt(rl, "TRSS-Yunzai 根目录", "/path/to/Yunzai")
    console.log(`\nbash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-plugin.sh) ${yunzaiDir}`)
    return
  }

  const name = await prompt(rl, "服务器名称", isWin ? "win-01" : isMac ? "mac-01" : "web-01")
  let token = await prompt(rl, "上报 token（留空则生成一个新 token）", "")
  let tokenGenerated = false
  if (!token) {
    token = makeToken()
    tokenGenerated = true
  }
  const reportUrl = await buildReportUrl(rl)

  const map = {
    "linux-systemd": `sudo bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-linux.sh) ${name} ${token} ${reportUrl}`,
    "linux-docker": `sudo bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-docker.sh) ${name} ${token} ${reportUrl}`,
    macos: `sudo bash <(curl -fsSL https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-macos.sh) ${name} ${token} ${reportUrl}`,
    windows: `irm https://raw.githubusercontent.com/qsbb/servermonitor/main/scripts/install-agent-windows.ps1 -OutFile $env:TEMP\\install-agent-windows.ps1\npowershell -ExecutionPolicy Bypass -File $env:TEMP\\install-agent-windows.ps1 -Name "${name}" -Token "${token}" -ReportUrl "${reportUrl}"`,
  }
  console.log(`\n${map[mode]}`)
  if (tokenGenerated && mode !== "plugin") {
    console.log(`\n绑定命令，复制到 Yunzai 主人私聊：`)
    console.log(`#服务器状态绑定 ${token}`)
  }
}

async function main() {
  console.log("servermonitor 一键安装器")
  console.log(`当前系统：${process.platform} ${process.arch}`)
  console.log("\n端口提示：2536 通常是 TRSS-Yunzai 的 HTTP 服务端口。servermonitor 使用同一个服务下的 /servermonitor/report 路径，不额外监听新端口。")

  const rl = createInterface({ input, output })
  try {
    const detected = defaultAgentMode()
    const choices = [
      "安装/更新 Yunzai 插件",
      `安装 agent：当前系统推荐（${detected}）`,
      "安装 agent：Linux systemd",
      "安装 agent：Linux Docker Compose",
      "安装 agent：Windows NSSM",
      "安装 agent：macOS launchd",
      "只生成命令，不执行",
    ]
    const choice = await choose(rl, "请选择要做什么", choices, 0)

    if (choice === 0) return await installPlugin(rl)
    if (choice === 1) return await installAgent(detected, rl)
    if (choice === 2) return await installAgent("linux-systemd", rl)
    if (choice === 3) return await installAgent("linux-docker", rl)
    if (choice === 4) return await installAgent("windows", rl)
    if (choice === 5) return await installAgent("macos", rl)

    const printChoices = ["plugin", "linux-systemd", "linux-docker", "windows", "macos"]
    const printLabels = ["Yunzai 插件", "Linux systemd agent", "Docker agent", "Windows agent", "macOS agent"]
    const idx = await choose(rl, "生成哪种命令", printLabels, 0)
    return await printCommands(printChoices[idx], rl)
  } finally {
    rl.close()
  }
}

main().catch(err => {
  console.error(`\n[servermonitor-installer] ${err.message || err}`)
  process.exit(1)
})
