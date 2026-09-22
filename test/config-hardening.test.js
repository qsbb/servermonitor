import test from "node:test"
import assert from "node:assert/strict"
import { basicConfig, runInTempRepo } from "./helpers/temp-repo.mjs"

test("inline comments are stripped outside quotes but preserved inside", async () => {
  const { code, result } = await runInTempRepo({
    config: basicConfig('shared_token: "sm_legacy_token" # keep this\npage_size: 8 # comment'),
    script: `
import { loadConfig } from "./config.js"
const config = await loadConfig(true)
console.log("__RESULT__" + JSON.stringify({ token: config.shared_token, pageSize: config.page_size }))
`,
  })
  assert.equal(code, 0)
  assert.equal(result.token, "sm_legacy_token")
  assert.equal(result.pageSize, 8)
})

test("quoted hash characters survive parsing", async () => {
  const { code, result } = await runInTempRepo({
    config: [
      "admins: []",
      "servers:",
      '  - name: "web-01"',
      '    token: "sm_11111111111111111111111111111111"',
      '    note: "prod #1"',
      "    createdAt: 1",
      "trusted_proxies: []",
      "report_enabled: true",
      "page_size: 8",
      "offline_timeout: 30",
      "public_status: false",
      "include_local: false",
      "alert:",
      "  enabled: false",
      "  cooldown: 120",
      "render:",
      "  imgType: png",
    ].join("\n") + "\n",
    script: `
import { loadConfig } from "./config.js"
const config = await loadConfig(true)
console.log("__RESULT__" + JSON.stringify({ note: config.servers[0].note }))
`,
  })
  assert.equal(code, 0)
  assert.equal(result.note, "prod #1")
})

test("config and pending files are written with restrictive permissions", async () => {
  const { code, result } = await runInTempRepo({
    script: `
import fs from "node:fs/promises"
import { loadConfig } from "./config.js"
import { handleReport } from "./model.js"
const token = "sm_" + "a".repeat(32)
await loadConfig(true)
const out = { statusCode: 200, status(c) { this.statusCode = c; return this }, json() { return this } }
await handleReport({ headers: {}, ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" }, body: { v: 1, name: "perm-node", cpu: { usage: 1 } }, get(n) { return n.toLowerCase() === "x-sm-token" ? token : "" } }, out)
const configMode = (await fs.stat("config.yaml")).mode & 0o777
const pendingMode = (await fs.stat("data/pending.json")).mode & 0o777
const dataMode = (await fs.stat("data")).mode & 0o777
console.log("__RESULT__" + JSON.stringify({ configMode: configMode.toString(8), pendingMode: pendingMode.toString(8), dataMode: dataMode.toString(8) }))
`,
  })
  assert.equal(code, 0)
  assert.equal(result.configMode, "600")
  assert.equal(result.pendingMode, "600")
  assert.equal(result.dataMode, "700")
})

test("deprecated shared_token is kept in memory but never written back", async () => {
  const { code, result } = await runInTempRepo({
    config: basicConfig('shared_token: "sm_legacy_token"'),
    script: `
import fs from "node:fs/promises"
import { loadConfig, saveConfig } from "./config.js"
const config = await loadConfig(true)
const inMemory = config.shared_token
await saveConfig({ ...config, page_size: 9 })
const raw = await fs.readFile("config.yaml", "utf8")
console.log("__RESULT__" + JSON.stringify({ inMemory, written: raw.includes("shared_token") }))
`,
  })
  assert.equal(code, 0)
  assert.equal(result.inMemory, "sm_legacy_token")
  assert.equal(result.written, false)
})

test("server reportUrl survives a config round trip", async () => {
  const { code, result } = await runInTempRepo({
    script: `
import { loadConfig, saveConfig } from "./config.js"
const config = await loadConfig(true)
config.servers.push({ name: "web-01", token: "sm_22222222222222222222222222222222", note: "", createdAt: 1, reportUrl: "http://example.com:2536/servermonitor/report" })
await saveConfig(config)
const reloaded = await loadConfig(true)
console.log("__RESULT__" + JSON.stringify({ reportUrl: reloaded.servers[0].reportUrl }))
`,
  })
  assert.equal(code, 0)
  assert.equal(result.reportUrl, "http://example.com:2536/servermonitor/report")
})
