import test from "node:test"
import assert from "node:assert/strict"
import { basicConfig, runInTempRepo } from "./helpers/temp-repo.mjs"

const PREAMBLE = `
function res() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.payload = payload; return this },
  }
}
const defaultBody = { v: 1, name: "node-1", cpu: { usage: 1 }, mem: { used: 1, total: 2 } }
function req({ token = "", body = defaultBody, ip = "127.0.0.1", headers = {} } = {}) {
  return {
    headers,
    ip,
    socket: { remoteAddress: ip },
    body,
    get(name) { return name.toLowerCase() === "x-sm-token" ? token : "" },
  }
}
`

test("legacy shared token is rejected with a migration hint", async () => {
  const shared = "sm_" + "a".repeat(32)
  const { code, result } = await runInTempRepo({
    config: basicConfig(`shared_token: "${shared}"`),
    script: `
import { handleReport } from "./model.js"
${PREAMBLE}
const first = res()
const second = res()
await handleReport(req({ token: "${shared}" }), first)
await handleReport(req({ token: "${shared}" }), second)
console.log("__RESULT__" + JSON.stringify({ first: [first.statusCode, first.payload], second: [second.statusCode, second.payload] }))
`,
  })
  assert.equal(code, 0)
  assert.equal(result.first[0], 401)
  assert.equal(result.second[0], 401)
  assert.equal(result.first[1].msg, "shared token disabled")
  assert.match(result.first[1].hint, /服务器状态命令/)
})

test("unknown tokens must match the sm_hex32 format", async () => {
  const { code, result } = await runInTempRepo({
    script: `
import { handleReport } from "./model.js"
${PREAMBLE}
const bad = res()
const good = res()
await handleReport(req({ token: "not-a-token" }), bad)
await handleReport(req({ token: "sm_${"b".repeat(32)}" }), good)
console.log("__RESULT__" + JSON.stringify({ bad: [bad.statusCode, bad.payload], good: [good.statusCode, good.payload] }))
`,
  })
  assert.equal(code, 0)
  assert.equal(result.bad[0], 401)
  assert.equal(result.good[0], 202)
  assert.equal(result.good[1].pending, true)
})

test("pending queue rejects new tokens instead of evicting existing ones", async () => {
  const existing = Array.from({ length: 100 }, (_, i) => ({
    token: `sm_${i.toString(16).padStart(32, "0")}`,
    name: `node-${i}`,
    lastSeen: Date.now(),
    snap: { v: 1, name: `node-${i}` },
  }))
  const { code, result } = await runInTempRepo({
    files: { "data/pending.json": JSON.stringify({ v: 1, savedAt: Date.now(), pending: existing }) },
    script: `
import fs from "node:fs/promises"
import { handleReport } from "./model.js"
${PREAMBLE}
const newToken = "sm_${"c".repeat(32)}"
const out = res()
await handleReport(req({ token: newToken }), out)
const saved = JSON.parse(await fs.readFile("data/pending.json", "utf8"))
console.log("__RESULT__" + JSON.stringify({ status: out.statusCode, msg: out.payload.msg, size: saved.pending.length, firstKept: saved.pending.some(item => item.token === "${"sm_" + "0".repeat(32)}") }))
`,
  })
  assert.equal(code, 0)
  assert.equal(result.status, 429)
  assert.equal(result.msg, "pending queue full")
  assert.equal(result.size, 100)
  assert.equal(result.firstKept, true)
})

test("pending writes are debounced and flushed explicitly", async () => {
  const { code, result } = await runInTempRepo({
    script: `
import fs from "node:fs/promises"
import { handleReport, flushPending } from "./model.js"
${PREAMBLE}
let writes = 0
const original = fs.writeFile
fs.writeFile = async (file, ...rest) => {
  if (String(file).includes("pending.json")) writes++
  return original(file, ...rest)
}
for (let i = 0; i < 5; i++) {
  const token = "sm_" + i.toString(16).padStart(32, "0")
  const out = res()
  await handleReport(req({ token }), out)
}
const writesBeforeFlush = writes
await flushPending()
const saved = JSON.parse(await fs.readFile("data/pending.json", "utf8"))
console.log("__RESULT__" + JSON.stringify({ writesBeforeFlush, totalWrites: writes, saved: saved.pending.length }))
`,
  })
  assert.equal(code, 0)
  assert.equal(result.writesBeforeFlush, 1)
  assert.equal(result.totalWrites, 2)
  assert.equal(result.saved, 5)
})

test("pending creation is rate limited per IP", async () => {
  const { code, result } = await runInTempRepo({
    script: `
import { handleReport } from "./model.js"
${PREAMBLE}
const statuses = []
for (let i = 0; i < 11; i++) {
  const out = res()
  await handleReport(req({ token: "sm_" + (i + 100).toString(16).padStart(32, "0") }), out)
  statuses.push(out.statusCode)
}
console.log("__RESULT__" + JSON.stringify({ statuses }))
`,
  })
  assert.equal(code, 0)
  assert.deepEqual(result.statuses.slice(0, 10), Array(10).fill(202))
  assert.equal(result.statuses[10], 429)
})

test("registered independent tokens keep working after hardening", async () => {
  const token = "sm_" + "f".repeat(32)
  const { code, result } = await runInTempRepo({
    config: basicConfig(`servers:
  - name: "legacy-node"
    token: "${token}"
    note: ""
    createdAt: 1`),
    script: `
import { handleReport, state } from "./model.js"
${PREAMBLE}
const out = res()
await handleReport(req({ token: "${token}" }), out)
console.log("__RESULT__" + JSON.stringify({
  status: out.statusCode,
  payload: out.payload,
  recordState: state.records.get("legacy-node")?.state || null,
  lastSeen: state.records.get("legacy-node")?.lastSeen || 0,
}))
`,
  })
  assert.equal(code, 0)
  assert.equal(result.status, 200)
  assert.equal(result.payload.ok, true)
  assert.equal(result.payload.name, "legacy-node")
  assert.equal(result.payload.auto, false)
  assert.equal(result.recordState, "online")
  assert.ok(result.lastSeen > 0)
})

test("report ingestion can be disabled by config", async () => {
  const { code, result } = await runInTempRepo({
    config: basicConfig("report_enabled: false"),
    script: `
import { handleReport } from "./model.js"
${PREAMBLE}
const out = res()
await handleReport(req({ token: "sm_${"d".repeat(32)}" }), out)
console.log("__RESULT__" + JSON.stringify({ status: out.statusCode, msg: out.payload.msg }))
`,
  })
  assert.equal(code, 0)
  assert.equal(result.status, 503)
  assert.equal(result.msg, "report ingestion disabled")
})
