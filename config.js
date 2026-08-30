import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

export const PLUGIN_NAME = "servermonitor"
export const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url))
export const CONFIG_FILE = path.join(ROOT_DIR, "config.yaml")
export const DATA_DIR = path.join(ROOT_DIR, "data")
export const SNAPSHOT_FILE = path.join(DATA_DIR, "snapshots.json")

const DEFAULT_CONFIG = {
  admins: [],
  servers: [],
  shared_token: "",
  page_size: 8,
  offline_timeout: 30,
  public_status: true,
  include_local: true,
  alert: {
    enabled: true,
    cooldown: 120,
  },
  render: {
    imgType: "png",
  },
  show_ip_in_image: false,
}

const cache = {
  loaded: false,
  mtimeMs: 0,
  data: null,
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function toInt(value, fallback) {
  const num = Number.parseInt(value, 10)
  return Number.isFinite(num) ? num : fallback
}

function toBool(value, fallback = false) {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true
    if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false
  }
  return fallback
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""))
}

function parseScalar(value) {
  const s = String(value ?? "").trim()
  if (!s) return ""
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      return JSON.parse(s)
    } catch {
      const inner = s.slice(1, -1).trim()
      return inner ? inner.split(",").map(i => parseScalar(i.trim())) : []
    }
  }
  if (["true", "false"].includes(s.toLowerCase())) return s.toLowerCase() === "true"
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s)
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    if (s.startsWith('"')) {
      try { return JSON.parse(s) } catch { return s.slice(1, -1) }
    }
    return s.slice(1, -1).replace(/''/g, "'")
  }
  return s
}

function parseKeyValue(text) {
  const idx = text.indexOf(":")
  if (idx < 0) return null
  const key = text.slice(0, idx).trim()
  const value = text.slice(idx + 1).trim()
  if (!key) return null
  return [key, parseScalar(value)]
}

function parseConfigText(raw) {
  const parsed = {}
  let section = null
  let currentServer = null

  for (const sourceLine of String(raw || "").split(/\r?\n/)) {
    if (!sourceLine.trim() || sourceLine.trim().startsWith("#")) continue
    const indent = sourceLine.match(/^\s*/)?.[0]?.length || 0
    const line = sourceLine.trim()

    if (indent === 0) {
      currentServer = null
      if (/^admins:\s*\[\]\s*$/.test(line)) {
        parsed.admins = []
        section = null
        continue
      }
      if (/^servers:\s*\[\]\s*$/.test(line)) {
        parsed.servers = []
        section = null
        continue
      }
      if (line === "admins:") {
        parsed.admins = []
        section = "admins"
        continue
      }
      if (line === "servers:") {
        parsed.servers = []
        section = "servers"
        continue
      }
      if (line === "alert:") {
        parsed.alert = parsed.alert || {}
        section = "alert"
        continue
      }
      if (line === "render:") {
        parsed.render = parsed.render || {}
        section = "render"
        continue
      }
      const pair = parseKeyValue(line)
      if (pair) parsed[pair[0]] = pair[1]
      section = null
      continue
    }

    if (section === "admins") {
      if (line.startsWith("- ")) parsed.admins.push(String(parseScalar(line.slice(2))))
      continue
    }

    if (section === "servers") {
      if (!Array.isArray(parsed.servers)) parsed.servers = []
      if (line.startsWith("- ")) {
        currentServer = {}
        parsed.servers.push(currentServer)
        const rest = line.slice(2).trim()
        const pair = rest ? parseKeyValue(rest) : null
        if (pair) currentServer[pair[0]] = pair[1]
        continue
      }
      if (currentServer) {
        const pair = parseKeyValue(line)
        if (pair) currentServer[pair[0]] = pair[1]
      }
      continue
    }

    if (section === "alert" || section === "render") {
      const pair = parseKeyValue(line)
      if (pair) parsed[section][pair[0]] = pair[1]
    }
  }

  return parsed
}

function stringifyConfig(config) {
  const data = normalizeConfig(config)
  const lines = []
  if (data.admins.length) {
    lines.push("admins:")
    for (const id of data.admins) lines.push(`  - ${yamlString(id)}`)
  } else {
    lines.push("admins: []")
  }

  if (data.servers.length) {
    lines.push("servers:")
    for (const server of data.servers) {
      lines.push(`  - name: ${yamlString(server.name)}`)
      lines.push(`    token: ${yamlString(server.token)}`)
      lines.push(`    note: ${yamlString(server.note || "")}`)
      lines.push(`    createdAt: ${Number(server.createdAt) || Date.now()}`)
    }
  } else {
    lines.push("servers: []")
  }

  lines.push(`shared_token: ${yamlString(data.shared_token)}`)
  lines.push(`page_size: ${data.page_size}`)
  lines.push(`offline_timeout: ${data.offline_timeout}`)
  lines.push(`public_status: ${data.public_status}`)
  lines.push(`include_local: ${data.include_local}`)
  lines.push("alert:")
  lines.push(`  enabled: ${data.alert.enabled}`)
  lines.push(`  cooldown: ${data.alert.cooldown}`)
  lines.push("render:")
  lines.push(`  imgType: ${yamlString(data.render.imgType)}`)
  lines.push(`show_ip_in_image: ${data.show_ip_in_image}`)
  return `${lines.join("\n")}\n`
}

function normalizeServer(item) {
  if (!item || typeof item !== "object") return null
  const name = String(item.name ?? "").trim()
  const token = String(item.token ?? "").trim()
  if (!name || !token) return null
  return {
    name,
    token,
    note: String(item.note ?? "").trim(),
    createdAt: Number(item.createdAt) || Date.now(),
  }
}

export function defaultConfig() {
  return clone(DEFAULT_CONFIG)
}

export function normalizeConfig(input = {}) {
  const base = defaultConfig()
  const config = input && typeof input === "object" ? input : {}

  base.admins = Array.isArray(config.admins)
    ? config.admins.map(i => String(i).trim()).filter(Boolean)
    : []

  base.servers = Array.isArray(config.servers)
    ? config.servers.map(normalizeServer).filter(Boolean)
    : []

  base.shared_token = String(config.shared_token || "").trim() || makeToken()
  base.page_size = Math.max(1, toInt(config.page_size, base.page_size))
  base.offline_timeout = Math.max(5, toInt(config.offline_timeout, base.offline_timeout))
  base.public_status = toBool(config.public_status, base.public_status)
  base.include_local = toBool(config.include_local, base.include_local)

  const alert = config.alert && typeof config.alert === "object" ? config.alert : {}
  base.alert = {
    enabled: toBool(alert.enabled, base.alert.enabled),
    cooldown: Math.max(30, toInt(alert.cooldown, base.alert.cooldown)),
  }

  const render = config.render && typeof config.render === "object" ? config.render : {}
  base.render = {
    imgType: ["png", "jpeg"].includes(String(render.imgType || "").toLowerCase())
      ? String(render.imgType).toLowerCase()
      : base.render.imgType,
  }

  base.show_ip_in_image = toBool(config.show_ip_in_image, base.show_ip_in_image)
  return base
}

async function ensureStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true })
  try {
    await fs.access(CONFIG_FILE)
  } catch {
    await fs.writeFile(CONFIG_FILE, stringifyConfig({ ...DEFAULT_CONFIG, shared_token: makeToken() }), "utf8")
  }
}

export async function loadConfig(force = false) {
  await ensureStorage()
  let stat = await fs.stat(CONFIG_FILE)
  if (!force && cache.loaded && cache.mtimeMs === stat.mtimeMs && cache.data) {
    return clone(cache.data)
  }
  const raw = await fs.readFile(CONFIG_FILE, "utf8")
  const parsed = parseConfigText(raw)
  const data = normalizeConfig(parsed)
  if (!String(parsed.shared_token || "").trim()) {
    await fs.writeFile(CONFIG_FILE, stringifyConfig(data), "utf8")
    stat = await fs.stat(CONFIG_FILE)
  }
  cache.loaded = true
  cache.mtimeMs = stat.mtimeMs
  cache.data = data
  return clone(data)
}

export async function saveConfig(config) {
  await ensureStorage()
  const data = normalizeConfig(config)
  await fs.writeFile(CONFIG_FILE, stringifyConfig(data), "utf8")
  const stat = await fs.stat(CONFIG_FILE)
  cache.loaded = true
  cache.mtimeMs = stat.mtimeMs
  cache.data = data
  return clone(data)
}

export async function updateConfig(mutator) {
  const current = await loadConfig()
  const draft = clone(current)
  const next = await mutator(draft)
  return await saveConfig(next ?? draft)
}

export function makeToken() {
  return `sm_${crypto.randomBytes(16).toString("hex")}`
}

export function getReportPaths() {
  return ["/servermonitor", "/server-monitor"]
}

export function getReportUrlPath() {
  return "/servermonitor/report"
}

export async function ensureConfigExists() {
  await ensureStorage()
  return CONFIG_FILE
}
