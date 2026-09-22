import test from "node:test"
import assert from "node:assert/strict"
import {
  buildAddServerReply,
  makeAgentCommand,
  normalizeReportUrl,
  parseAddServerExtra,
} from "../model.js"

test("parses optional address while preserving the old note form", () => {
  assert.deepEqual(parseAddServerExtra("http://lingxiz.cn:2536"), {
    requestedAddress: "http://lingxiz.cn:2536",
    note: "",
  })
  assert.deepEqual(parseAddServerExtra("https://example.com/yunzai 主力服务器"), {
    requestedAddress: "https://example.com/yunzai",
    note: "主力服务器",
  })
  assert.deepEqual(parseAddServerExtra("主力服务器"), {
    requestedAddress: "",
    note: "主力服务器",
  })
  assert.deepEqual(parseAddServerExtra("ftp://example.com"), {
    requestedAddress: "ftp://example.com",
    note: "",
  })
})

test("normalizes server base addresses and complete report URLs", () => {
  assert.equal(
    normalizeReportUrl("http://lingxiz.cn:2536"),
    "http://lingxiz.cn:2536/servermonitor/report",
  )
  assert.equal(
    normalizeReportUrl("http://lingxiz.cn:2536/servermonitor/report"),
    "http://lingxiz.cn:2536/servermonitor/report",
  )
  assert.equal(
    normalizeReportUrl("https://example.com/yunzai/"),
    "https://example.com/yunzai/servermonitor/report",
  )
  assert.equal(
    normalizeReportUrl("https://example.com/server-monitor/report/"),
    "https://example.com/server-monitor/report",
  )
})

test("rejects unsafe or ambiguous report addresses", () => {
  assert.throws(() => normalizeReportUrl("lingxiz.cn:2536"), /http:\/\/ 或 https:\/\//)
  assert.throws(() => normalizeReportUrl("ftp://example.com"), /仅支持/)
  assert.throws(() => normalizeReportUrl("https://user:pass@example.com"), /用户名或密码/)
  assert.throws(() => normalizeReportUrl("https://example.com?token=x"), /查询参数或锚点/)
})

test("agent command uses the selected public report URL", () => {
  assert.equal(
    makeAgentCommand({
      reportUrl: "http://lingxiz.cn:2536",
      name: "4c4g",
      token: "sm_test",
      interval: 10,
    }),
    'node agent.mjs --name "4c4g" --token "sm_test" --report-url "http://lingxiz.cn:2536/servermonitor/report" --interval "10"',
  )
  assert.match(
    makeAgentCommand({ baseUrl: "https://example.com", name: "legacy", token: "sm_test" }),
    /--report-url "https:\/\/example\.com\/servermonitor\/report"/,
  )
})

test("selected reply format keeps address and command consistent", () => {
  const reportUrl = normalizeReportUrl("http://lingxiz.cn:2536")
  const command = makeAgentCommand({ reportUrl, name: "4c4g", token: "sm_test", interval: 10 })
  const reply = buildAddServerReply({ name: "4c4g", token: "sm_test", reportUrl, command })

  assert.match(reply, /^【服务器添加成功】\n\n名称：4c4g/)
  assert.match(reply, /上报地址：http:\/\/lingxiz\.cn:2536\/servermonitor\/report/)
  assert.match(reply, /专属令牌：sm_test/)
  assert.match(reply, /--report-url "http:\/\/lingxiz\.cn:2536\/servermonitor\/report"/)
  assert.doesNotMatch(reply, /localhost|127\.0\.0\.1/)
})
