import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import YAML from "yaml"

export const PLUGIN_NAME = "servermonitor"
export const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url))
export const CONFIG_FILE = path.join(ROOT_DIR, "config.yaml")
export const DATA_DIR = path.join(ROOT_DIR, "data")
export const SNAPSHOT_FILE = path.join(DATA_DIR, "snapshots.json")

const DEFAULT_CONFIG = {
  admins: [],
  servers: [],
  page_size: 8,
  offline_timeout: 30,
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

  base.page_size = Math.max(1, toInt(config.page_size, base.page_size))
  base.offline_timeout = Math.max(5, toInt(config.offline_timeout, base.offline_timeout))

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
    await fs.writeFile(CONFIG_FILE, YAML.stringify(DEFAULT_CONFIG), "utf8")
  }
}

export async function loadConfig(force = false) {
  await ensureStorage()
  const stat = await fs.stat(CONFIG_FILE)
  if (!force && cache.loaded && cache.mtimeMs === stat.mtimeMs && cache.data) {
    return clone(cache.data)
  }
  const raw = await fs.readFile(CONFIG_FILE, "utf8")
  const parsed = YAML.parse(raw) ?? {}
  const data = normalizeConfig(parsed)
  cache.loaded = true
  cache.mtimeMs = stat.mtimeMs
  cache.data = data
  return clone(data)
}

export async function saveConfig(config) {
  await ensureStorage()
  const data = normalizeConfig(config)
  await fs.writeFile(CONFIG_FILE, YAML.stringify(data), "utf8")
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
