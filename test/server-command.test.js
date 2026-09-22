import test from "node:test"
import assert from "node:assert/strict"
import { basicConfig, runInTempRepo } from "./helpers/temp-repo.mjs"

const server = (reportUrl) => [
  "servers:",
  '  - name: "web-01"',
  '    token: "sm_11111111111111111111111111111111"',
  reportUrl ? `    reportUrl: "${reportUrl}"` : null,
  '    note: ""',
  "    createdAt: 1",
].filter(Boolean).join("\n")

test("buildServerCommand reuses the persisted report URL", async () => {
  const { code, result } = await runInTempRepo({
    config: basicConfig(server("http://lingxiz.cn:2536/servermonitor/report")),
    script: `
import { buildServerCommand } from "./model.js"
const info = await buildServerCommand("web-01", { configuredUrl: "http://127.0.0.1:2536" })
console.log("__RESULT__" + JSON.stringify(info))
`,
  })
  assert.equal(code, 0)
  assert.equal(result.reportUrl, "http://lingxiz.cn:2536/servermonitor/report")
  assert.match(result.command, /--report-url "http:\/\/lingxiz\.cn:2536\/servermonitor\/report"/)
  assert.equal(result.warning, "")
})

test("buildServerCommand warns when only a loopback URL is known", async () => {
  const { code, result } = await runInTempRepo({
    config: basicConfig(server("")),
    script: `
import { buildServerCommand } from "./model.js"
const info = await buildServerCommand("web-01", { configuredUrl: "http://127.0.0.1:2536" })
console.log("__RESULT__" + JSON.stringify(info))
`,
  })
  assert.equal(code, 0)
  assert.match(result.warning, /回环地址/)
})

test("buildServerCommand reports unknown servers", async () => {
  const { code, result } = await runInTempRepo({
    script: `
import { buildServerCommand } from "./model.js"
const info = await buildServerCommand("missing", {}).then(() => null, error => error.message)
console.log("__RESULT__" + JSON.stringify({ info }))
`,
  })
  assert.equal(code, 0)
  assert.match(result.info, /未找到服务器/)
})
