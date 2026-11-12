import test from "node:test"
import assert from "node:assert/strict"
import { runInTempRepo } from "./helpers/temp-repo.mjs"

const TOKEN = `sm_${"c".repeat(32)}`

function alertConfig({ extra = "", quiet = "", enabled = true } = {}) {
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
    `  enabled: ${enabled}`,
    "  cooldown: 120",
    `  quiet_hours: "${quiet}"`,
    "  rules:",
    "    - metric: cpu_usage",
    "      threshold: 50",
    "      for: 0",
    "    - metric: smart_failed",
    "      threshold: 1",
    "      for: 0",
    "      cooldown: 600",
    "render:",
    '  imgType: "png"',
    extra,
  ].filter(Boolean).join("\n") + "\n"
}

test("alert rules and quiet hours survive a config round trip", async () => {
  const { code, result } = await runInTempRepo({
    config: alertConfig({ quiet: "23:00-08:00" }),
    script: `
import { loadConfig, saveConfig } from "./config.js"
const config = await loadConfig(true)
const saved = await saveConfig(config)
const reloaded = await loadConfig(true)
console.log("__RESULT__" + JSON.stringify({
  rules: config.alert.rules,
  quiet: config.alert.quiet_hours,
  enabled: config.alert.enabled,
  reloadedRules: reloaded.alert.rules,
  text: saved.alert.rules.length,
}))
`,
  })
  assert.equal(code, 0, result?.error)
  assert.deepEqual(result.rules, [
    { metric: "cpu_usage", threshold: 50, for: 0, cooldown: null, enabled: true },
    { metric: "smart_failed", threshold: 1, for: 0, cooldown: 600, enabled: true },
  ])
  assert.equal(result.quiet, "23:00-08:00")
  assert.equal(result.enabled, true)
  assert.deepEqual(result.reloadedRules, result.rules)
  assert.equal(result.text, 2)
})

test("an empty rules list keeps the alert section valid", async () => {
  const { code, result } = await runInTempRepo({
    config: alertConfig().replace(/  rules:\n(    - .*\n|      .*\n)*/, "  rules: []\n"),
    script: `
import { loadConfig, saveConfig } from "./config.js"
const config = await loadConfig(true)
const saved = await saveConfig(config)
const reloaded = await loadConfig(true)
console.log("__RESULT__" + JSON.stringify({ rules: config.alert.rules, reloaded: reloaded.alert.rules, savedRules: saved.alert.rules }))
`,
  })
  assert.equal(code, 0, result?.error)
  assert.deepEqual(result.rules, [])
  assert.deepEqual(result.reloaded, [])
  assert.deepEqual(result.savedRules, [])
})

test("scanAlerts notifies once per firing and persists alert state", async () => {
  const { code, result } = await runInTempRepo({
    config: alertConfig(),
    script: `
import fs from "node:fs/promises"
import { handleReport, scanAlerts, persist } from "./model.js"
const sent = []
globalThis.Bot = { sendMasterMsg: async msg => { sent.push(msg) } }
const payload = {
  v: 1, name: "n1", agent_ts: Date.now(),
  cpu: { usage: 80 }, mem: { used: 1, total: 2 },
  disks: [{ mount: "/", used: 10, total: 100, smart: { passed: false, temp: 52, reallocated: 8 } }],
}
const out = { statusCode: 200, payload: null, status(c) { this.statusCode = c; return this }, json(p) { this.payload = p; return this } }
await handleReport({ headers: {}, ip: "10.0.0.9", socket: { remoteAddress: "10.0.0.9" }, body: payload, get(n) { return n.toLowerCase() === "x-sm-token" ? "${TOKEN}" : "" } }, out)
const first = await scanAlerts(Date.now())
const second = await scanAlerts(Date.now() + 10_000)
await persist()
const saved = JSON.parse(await fs.readFile("data/snapshots.json", "utf8"))
console.log("__RESULT__" + JSON.stringify({
  reportStatus: out.statusCode,
  first: first.length,
  second: second.length,
  message: sent[0] || "",
  alertKeys: Object.keys(saved.alerts?.n1 || {}),
}))
`,
  })
  assert.equal(code, 0, result?.error)
  assert.equal(result.reportStatus, 200)
  assert.equal(result.first, 2)
  assert.equal(result.second, 0)
  assert.match(result.message, /CPU 使用率/)
  assert.match(result.message, /磁盘 SMART/)
  assert.deepEqual(result.alertKeys.sort(), ["cpu_usage:50:0", "smart_failed:1:0"])
})

test("scanAlerts stays silent when alerting is disabled or rules are empty", async () => {
  const { code, result } = await runInTempRepo({
    config: alertConfig({ enabled: false }),
    script: `
import { handleReport, scanAlerts } from "./model.js"
const sent = []
globalThis.Bot = { sendMasterMsg: async msg => { sent.push(msg) } }
const payload = { v: 1, name: "n1", cpu: { usage: 99 }, mem: { used: 1, total: 2 } }
const out = { statusCode: 200, payload: null, status(c) { this.statusCode = c; return this }, json(p) { this.payload = p; return this } }
await handleReport({ headers: {}, ip: "10.0.0.9", socket: { remoteAddress: "10.0.0.9" }, body: payload, get(n) { return n.toLowerCase() === "x-sm-token" ? "${TOKEN}" : "" } }, out)
const events = await scanAlerts(Date.now())
console.log("__RESULT__" + JSON.stringify({ events: events.length, sent: sent.length }))
`,
  })
  assert.equal(code, 0, result?.error)
  assert.equal(result.events, 0)
  assert.equal(result.sent, 0)
})
