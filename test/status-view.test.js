import test from "node:test"
import assert from "node:assert/strict"
import { decorateEntry, shouldShowLocalEntry, sortEntriesByCardLength } from "../model.js"

function makeRecord(net) {
  return {
    name: "web-01",
    lastSeen: 1_000,
    snap: {
      v: 1,
      name: "web-01",
      agent_ts: 1_000,
      os: { platform: "linux", hostname: "web-01" },
      cpu: { model: "x", cores: 4, usage: 10, temp: null, power: null },
      gpus: [],
      mem: { used: 1, total: 2, available: 1.5, swapUsed: 0, swapTotal: 1 },
      disks: [{ mount: "/", used: 10, total: 100 }],
      net,
    },
  }
}

test("network block renders as two lines", () => {
  const entry = decorateEntry(
    { name: "web-01" },
    makeRecord({ iface: "eth0", rxSec: 1.2, txSec: 0.45, rxTotal: 4.5, txTotal: 21 }),
    1_000,
    30_000,
  )
  assert.equal(entry.netLines.length, 2)
  assert.equal(entry.netLines[0], "实时 ↓ 1.20MB/s · ↑ 0.45MB/s")
  assert.equal(entry.netLines[1], "累计 ↓ 4.5GB · ↑ 21.0GB")
})

test("network block degrades to one line or none", () => {
  const partial = decorateEntry(
    { name: "web-01" },
    makeRecord({ iface: "eth0", rxSec: null, txSec: null, rxTotal: 4.5, txTotal: null }),
    1_000,
    30_000,
  )
  assert.deepEqual(partial.netLines, ["累计 ↓ 4.5GB"])

  const ratesOnly = decorateEntry(
    { name: "web-01" },
    makeRecord({ iface: "eth0", rxSec: 0, txSec: 0.2, rxTotal: null, txTotal: null }),
    1_000,
    30_000,
  )
  assert.deepEqual(ratesOnly.netLines, ["实时 ↓ 0.00MB/s · ↑ 0.20MB/s"])

  const empty = decorateEntry({ name: "web-01" }, makeRecord(null), 1_000, 30_000)
  assert.deepEqual(empty.netLines, [])
  assert.equal(empty.netText, "无网络数据")
})

test("the local card is hidden only when explicitly declared", () => {
  const config = { include_local: true, servers: [{ name: "4c4g" }, { name: "LXYY" }] }
  assert.equal(shouldShowLocalEntry(config), true)
  assert.equal(shouldShowLocalEntry({ ...config, local_server_name: "4c4g" }), false)
  assert.equal(shouldShowLocalEntry({ ...config, local_server_name: "not-registered" }), true)
  assert.equal(shouldShowLocalEntry({ ...config, include_local: false, local_server_name: "4c4g" }), false)
  assert.equal(shouldShowLocalEntry({ include_local: true, servers: [{ name: "本机" }] }), false)
})

test("hostname is never used to guess the local machine", () => {
  // 两台不同机器同名、容器里报宿主主机名……这些都不该影响卡片
  const config = { include_local: true, servers: [{ name: "4c4g" }] }
  assert.equal(shouldShowLocalEntry(config), true)
})

test("normal view summarises disks while pro view keeps the details", () => {
  const record = makeRecord({ iface: "eth0", rxSec: 1, txSec: 1, rxTotal: 1, txTotal: 1 })
  record.snap.disks = [
    { mount: "/", used: 10, total: 100 },
    { mount: "/data", used: 50, total: 100 },
  ]
  const normal = decorateEntry({ name: "web-01" }, record, 1_000, 30_000)
  assert.equal(normal.pro, false)
  assert.equal(normal.diskSummary.hasPct, true)
  assert.equal(normal.diskSummary.pct, 30)
  assert.equal(normal.diskSummary.count, 2)
  assert.equal(normal.diskSummary.text, "60.0GB / 200.0GB")

  const pro = decorateEntry({ name: "web-01" }, record, 1_000, 30_000, { pro: true })
  assert.equal(pro.pro, true)
  assert.equal(pro.disks.length, 2)
  assert.equal(pro.diskSummary.pct, 30)
})

test("disk summary ignores mounts without a usable total", () => {
  const record = makeRecord(null)
  record.snap.disks = [
    { mount: "/", used: 10, total: 100 },
    { mount: "/broken", used: 5, total: 0 },
    { mount: "/unknown", used: null, total: 100 },
  ]
  const entry = decorateEntry({ name: "web-01" }, record, 1_000, 30_000)
  assert.equal(entry.diskSummary.count, 1)
  assert.equal(entry.diskSummary.pct, 10)
})

test("pro layout sorts cards from the longest to the shortest", () => {
  const short = { name: "b-short", cardRows: 10 }
  const long = { name: "a-long", cardRows: 24 }
  const mid = { name: "c-mid", cardRows: 16 }
  assert.deepEqual(
    sortEntriesByCardLength([short, long, mid]).map(i => i.name),
    ["a-long", "c-mid", "b-short"],
  )
})
