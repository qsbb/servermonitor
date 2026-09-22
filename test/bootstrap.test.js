import test from "node:test"
import assert from "node:assert/strict"
import { basicConfig, runInTempRepo } from "./helpers/temp-repo.mjs"

function serverList(count) {
  const lines = ["servers:"]
  for (let i = 0; i < count; i++) {
    lines.push(`  - name: "pre-${i}"`)
    lines.push(`    token: "sm_${i.toString(16).padStart(32, "0")}"`)
    lines.push('    note: ""')
    lines.push("    createdAt: 1")
  }
  return lines.join("\n")
}

test("concurrent bootstrap waits for hydration instead of racing it", async () => {
  const token = `sm_${"e".repeat(32)}`
  const pending = {
    v: 1,
    savedAt: Date.now(),
    pending: [{ token, name: "race-node", lastSeen: Date.now(), snap: { v: 1, name: "race-node" } }],
  }
  const { code, result } = await runInTempRepo({
    files: { "data/pending.json": JSON.stringify(pending) },
    script: `
import { bindServerToken, getEntries } from "./model.js"
const [entries, bind] = await Promise.allSettled([getEntries(), bindServerToken("${token}")])
console.log("__RESULT__" + JSON.stringify({ entries: entries.status, bind: bind.status, error: bind.reason?.message || null }))
`,
  })
  assert.equal(code, 0)
  assert.equal(result.entries, "fulfilled")
  assert.equal(result.bind, "fulfilled")
  assert.equal(result.error, null)
})

test("bootstrap failure resets and allows a later retry", async () => {
  const { code, result } = await runInTempRepo({
    script: `
import fs from "node:fs/promises"
import { listPendingTokens } from "./model.js"
await fs.rename("config.yaml", "config.yaml.bak")
await fs.mkdir("config.yaml")
const first = await listPendingTokens().then(value => ({ ok: true, value }), error => ({ ok: false, code: error.code || error.message }))
await fs.rmdir("config.yaml")
await fs.rename("config.yaml.bak", "config.yaml")
const second = await listPendingTokens().then(value => ({ ok: true, value }), error => ({ ok: false, code: error.code || error.message }))
console.log("__RESULT__" + JSON.stringify({ first, second }))
`,
  })
  assert.equal(code, 0)
  assert.equal(result.first.ok, false)
  assert.equal(result.first.code, "EISDIR")
  assert.equal(result.second.ok, true)
  assert.deepEqual(result.second.value, [])
})

test("server cap is enforced inside the serialized write queue", async () => {
  const pendingItems = Array.from({ length: 20 }, (_, i) => ({
    token: `sm_${(i + 500).toString(16).padStart(32, "0")}`,
    name: `new-${i}`,
    lastSeen: Date.now(),
    snap: { v: 1, name: `new-${i}` },
  }))
  const { code, result } = await runInTempRepo({
    config: basicConfig(serverList(63)),
    files: { "data/pending.json": JSON.stringify({ v: 1, savedAt: Date.now(), pending: pendingItems }) },
    script: `
import { bindServerToken } from "./model.js"
import { loadConfig } from "./config.js"
const results = await Promise.allSettled(${JSON.stringify(pendingItems.map(item => item.token))}.map(token => bindServerToken(token)))
const config = await loadConfig(true)
console.log("__RESULT__" + JSON.stringify({ fulfilled: results.filter(r => r.status === "fulfilled").length, rejected: results.filter(r => r.status === "rejected").length, servers: config.servers.length }))
`,
  })
  assert.equal(code, 0)
  assert.equal(result.fulfilled, 1)
  assert.equal(result.rejected, 19)
  assert.equal(result.servers, 64)
})
