import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { basicConfig, runInTempRepo } from "./helpers/temp-repo.mjs"
import {
  buildAddServerReply,
  looksLikeAddressWithoutScheme,
  parseDeleteTarget,
  usageHintFor,
} from "../model.js"

test("detects addresses that are missing an http/https prefix", () => {
  for (const value of ["lingxiz.cn:2536", "192.168.5.88:2536", "localhost:2536", "example.com/servermonitor/report"]) {
    assert.equal(looksLikeAddressWithoutScheme(value), true, value)
  }
  for (const value of ["主力服务器", "prod", "hello world", "http://example.com", "ftp://example.com", ""]) {
    assert.equal(looksLikeAddressWithoutScheme(value), false, value)
  }
})

test("usage hints match incomplete commands", () => {
  assert.match(usageHintFor("#服务器状态添加"), /服务器状态添加 <名称> \[上报地址\] \[备注\]/)
  assert.match(usageHintFor("#服务器状态绑定"), /服务器状态绑定 <token>/)
  assert.match(usageHintFor("#服务器状态改名 4c4g"), /改名 <旧名> <新名>/)
  assert.match(usageHintFor("#服务器状态命令"), /服务器状态命令 <名称>/)
  assert.match(usageHintFor("#服务器状态删除"), /删除服务器 <名称\|序号>/)
  assert.match(usageHintFor("#未知命令"), /服务器状态帮助/)
})

test("delete targets accept names and indexes", () => {
  assert.deepEqual(parseDeleteTarget("#删除服务器 3"), { target: "3", isIndex: true })
  assert.deepEqual(parseDeleteTarget("#删除服务器 +3"), { target: "3", isIndex: true })
  assert.deepEqual(parseDeleteTarget("#删除服务器 4c4g"), { target: "4c4g", isIndex: false })
  assert.equal(parseDeleteTarget("#服务器状态删除 4c4g"), null)
  assert.equal(parseDeleteTarget("#删除服务器"), null)
})

test("add-server reply surfaces loopback warnings", () => {
  const reply = buildAddServerReply({
    name: "4c4g",
    token: "sm_x",
    reportUrl: "http://127.0.0.1:2536/servermonitor/report",
    command: "node agent.mjs",
    warning: "警告：当前上报地址是回环地址",
  })
  assert.match(reply, /警告：当前上报地址是回环地址/)
})

test("local snapshot is cached for subsequent status commands", async () => {
  const { code, result } = await runInTempRepo({
    config: basicConfig("include_local: true"),
    script: `
import { performance } from "node:perf_hooks"
import { getEntries } from "./model.js"
const t0 = performance.now()
const first = await getEntries()
const t1 = performance.now()
const second = await getEntries()
const t2 = performance.now()
console.log("__RESULT__" + JSON.stringify({
  firstMs: +(t1 - t0).toFixed(1),
  secondMs: +(t2 - t1).toFixed(1),
  firstCount: first.length,
  secondCount: second.length,
  name: second[0]?.name || null,
}))
`,
  })
  assert.equal(code, 0, result?.stderr)
  assert.equal(result.firstCount, 1)
  assert.equal(result.secondCount, 1)
  assert.equal(result.name, "本机")
  assert.ok(result.firstMs >= 120, `first collection should sample CPU: ${result.firstMs}ms`)
  assert.ok(result.secondMs < 100, `second call should hit the cache: ${result.secondMs}ms`)
})

test("index.js declares the unified delete and incomplete-command rules", async () => {
  const source = await fs.readFile(new URL("../index.js", import.meta.url), "utf8")
  const ruleLines = source.split("\n").filter(line => line.includes("fnc:"))
  assert.ok(ruleLines.some(line => line.includes("deleteTarget") && line.includes("删除服务器")), "missing deleteTarget rule")
  assert.equal(ruleLines.filter(line => line.includes('fnc: "usage"')).length, 6, "expected 6 fallback usage rules")
  assert.ok(ruleLines.some(line => line.includes("添加$") && line.includes('fnc: "usage"')))
  assert.ok(ruleLines.some(line => line.includes("绑定$") && line.includes('fnc: "usage"')))
  assert.ok(ruleLines.some(line => line.includes("改名") && line.includes('fnc: "usage"')))
  assert.ok(ruleLines.some(line => line.includes("命令$") && line.includes('fnc: "usage"')))
  assert.ok(ruleLines.some(line => line.includes("删除$") && line.includes('fnc: "usage"')))
})
