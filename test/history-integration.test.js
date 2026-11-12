import test from "node:test"
import assert from "node:assert/strict"
import { runInTempRepo } from "./helpers/temp-repo.mjs"

const TOKEN = `sm_${"d".repeat(32)}`

function historyConfig({ enabled = true, extra = "" } = {}) {
  return [
    "admins: []",
    "servers:",
    '  - name: "n1"',
    `    token: "${TOKEN}"`,
    '    note: ""',
    "    createdAt: 1",
    "trusted_proxies: []",
    "report_enabled: true",
    "page_size: 8",
    "offline_timeout: 30",
    "public_status: false",
    "include_local: false",
    "stale_after: 90",
    "status_cooldown: 10",
    'simple_style: "bars"',
    "alert:",
    "  enabled: true",
    "  cooldown: 120",
    '  quiet_hours: ""',
    "  rules: []",
    "history:",
    `  enabled: ${enabled}`,
    "  raw_hours: 6",
    "  hourly_days: 7",
    "  daily_days: 90",
    "render:",
    '  imgType: "png"',
    extra,
  ].filter(Boolean).join("\n") + "\n"
}

test("history config survives a round trip", async () => {
  const { code, result } = await runInTempRepo({
    config: historyConfig(),
    script: `
import { loadConfig, saveConfig } from "./config.js"
const config = await loadConfig(true)
await saveConfig(config)
const reloaded = await loadConfig(true)
console.log("__RESULT__" + JSON.stringify({ history: config.history, reloaded: reloaded.history }))
`,
  })
  assert.equal(code, 0, result?.error)
  assert.deepEqual(result.history, { enabled: true, raw_hours: 6, hourly_days: 7, daily_days: 90 })
  assert.deepEqual(result.reloaded, result.history)
})

test("persist records history points for online servers", async () => {
  const { code, result } = await runInTempRepo({
    config: historyConfig(),
    script: `
import fs from "node:fs/promises"
import { handleReport, persist } from "./model.js"
const payload = { v: 1, name: "n1", cpu: { usage: 42.5 }, mem: { used: 4, total: 8 }, net: { rxSec: 1.5, txSec: 0.5 } }
const out = { statusCode: 200, payload: null, status(c) { this.statusCode = c; return this }, json(p) { this.payload = p; return this } }
await handleReport({ headers: {}, ip: "10.0.0.9", socket: { remoteAddress: "10.0.0.9" }, body: payload, get(n) { return n.toLowerCase() === "x-sm-token" ? "${TOKEN}" : "" } }, out)
await persist()
const history = JSON.parse(await fs.readFile("data/history.json", "utf8"))
const raw = history.series?.n1?.raw || []
console.log("__RESULT__" + JSON.stringify({ report: out.statusCode, count: raw.length, point: raw[0] || null }))
`,
  })
  assert.equal(code, 0, result?.error)
  assert.equal(result.report, 200)
  assert.ok(result.count >= 1)
  assert.equal(result.point.c, 42.5)
  assert.equal(result.point.m, 50)
  assert.equal(result.point.rx, 1.5)
  assert.ok(result.point.t > 0)
})

test("getTrend renders chart data from stored hourly points", async () => {
  const { code, result } = await runInTempRepo({
    config: historyConfig(),
    script: `
import fs from "node:fs/promises"
const now = Date.now()
const hourly = []
for (let i = 6; i >= 1; i--) {
  hourly.push({ t: now - i * 3600_000, c: 30 + i, cMax: 40 + i, m: 50, mMax: 60, rx: 1, rxMax: 3, tx: 0.5, txMax: 1, g: 10, gMax: 20 })
}
await fs.mkdir("data", { recursive: true })
await fs.writeFile("data/history.json", JSON.stringify({ v: 1, savedAt: now, series: { n1: { raw: [], hourly, daily: [] } } }))
const { getTrend } = await import("./model.js")
const data = await getTrend("n1", "24h")
const missing = await getTrend("nope", "24h")
console.log("__RESULT__" + JSON.stringify({
  enabled: data.enabled,
  empty: data.empty,
  charts: data.charts.map(c => c.key),
  summary: data.summary,
  rangeLabel: data.rangeLabel,
  missing,
}))
`,
  })
  assert.equal(code, 0, result?.error)
  assert.equal(result.enabled, true)
  assert.equal(result.empty, false)
  assert.deepEqual(result.charts, ["cpu", "mem", "net"])
  assert.match(result.summary, /CPU 均值/)
  assert.equal(result.rangeLabel, "24 小时")
  assert.equal(result.missing, null)
})

test("history can be disabled without breaking persist or getTrend", async () => {
  const { code, result } = await runInTempRepo({
    config: historyConfig({ enabled: false }),
    script: `
import fs from "node:fs/promises"
import { handleReport, persist, getTrend } from "./model.js"
const payload = { v: 1, name: "n1", cpu: { usage: 10 }, mem: { used: 1, total: 2 } }
const out = { statusCode: 200, payload: null, status(c) { this.statusCode = c; return this }, json(p) { this.payload = p; return this } }
await handleReport({ headers: {}, ip: "10.0.0.9", socket: { remoteAddress: "10.0.0.9" }, body: payload, get(n) { return n.toLowerCase() === "x-sm-token" ? "${TOKEN}" : "" } }, out)
await persist()
const trend = await getTrend("n1", "24h")
const fileExists = await fs.access("data/history.json").then(() => true, () => false)
console.log("__RESULT__" + JSON.stringify({ enabled: trend.enabled, empty: trend.empty, fileExists }))
`,
  })
  assert.equal(code, 0, result?.error)
  assert.equal(result.enabled, false)
  assert.equal(result.fileExists, false)
})

test("a corrupt history file is backed up and does not block startup", async () => {
  const { code, result } = await runInTempRepo({
    config: historyConfig(),
    files: { "data/history.json": "{ this is not json" },
    script: `
import fs from "node:fs/promises"
import { getTrend } from "./model.js"
const trend = await getTrend("n1", "24h")
const files = (await fs.readdir("data")).filter(name => name.startsWith("history.json.corrupt-"))
console.log("__RESULT__" + JSON.stringify({ empty: trend.empty, backups: files.length }))
`,
  })
  assert.equal(code, 0, result?.error)
  assert.equal(result.empty, true)
  assert.equal(result.backups, 1)
})
