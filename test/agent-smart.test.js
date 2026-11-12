import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"

let agent = null
let importError = null
try {
  agent = await import("../agent/agent.mjs")
} catch (err) {
  importError = err
}
const skip = agent ? false : `agent dependencies unavailable: ${importError?.message || importError}`

const readFixture = async name =>
  await fs.readFile(new URL(`./fixtures/smartctl/${name}`, import.meta.url), "utf8")

test("normalizeBlockDevice maps partitions to whole disks", { skip }, () => {
  assert.equal(agent.normalizeBlockDevice("/dev/sda2"), "/dev/sda")
  assert.equal(agent.normalizeBlockDevice("/dev/sda"), "/dev/sda")
  assert.equal(agent.normalizeBlockDevice("/dev/nvme0n1p1"), "/dev/nvme0n1")
  assert.equal(agent.normalizeBlockDevice("/dev/nvme0n1"), "/dev/nvme0n1")
  assert.equal(agent.normalizeBlockDevice("/dev/mmcblk0p1"), "/dev/mmcblk0")
  assert.equal(agent.normalizeBlockDevice("/dev/md0"), "/dev/md0")
  assert.equal(agent.normalizeBlockDevice("/dev/loop0"), "/dev/loop0")
  assert.equal(agent.normalizeBlockDevice("//192.168.5.88/AI"), null)
  assert.equal(agent.normalizeBlockDevice("/dev/mapper/vg-root"), null)
  assert.equal(agent.normalizeBlockDevice("C:"), null)
})

test("parseSmartScan dedupes partitions and rejects non-dev paths", { skip }, async () => {
  const scan = await readFixture("scan.json")
  const devices = await agent.parseSmartScan(scan)
  assert.deepEqual(devices, [
    { name: "/dev/sda", device: "/dev/sda" },
    { name: "/dev/nvme0", device: "/dev/nvme0" },
  ])
  assert.deepEqual(await agent.parseSmartScan("not json"), [])
  assert.deepEqual(await agent.parseSmartScan(""), [])
})

test("parseSmartHealth parses a healthy SATA disk", { skip }, async () => {
  const health = await agent.parseSmartHealth(await readFixture("sata-healthy.json"))
  assert.deepEqual(health, {
    passed: true,
    temp: 38,
    powerOnHours: 15322,
    reallocated: 0,
    pending: 0,
    mediaErrors: null,
  })
})

test("parseSmartHealth parses a failing disk with reallocated sectors", { skip }, async () => {
  const health = await agent.parseSmartHealth(await readFixture("sata-failing.json"))
  assert.equal(health.passed, false)
  assert.equal(health.temp, 52)
  assert.equal(health.reallocated, 8)
  assert.equal(health.pending, 2)
})

test("parseSmartHealth parses NVMe media errors", { skip }, async () => {
  const health = await agent.parseSmartHealth(await readFixture("nvme-media-errors.json"))
  assert.equal(health.passed, true)
  assert.equal(health.temp, 41)
  assert.equal(health.powerOnHours, 900)
  assert.equal(health.mediaErrors, 3)
  assert.equal(health.reallocated, null)
})

test("parseSmartHealth ignores junk and empty payloads", { skip }, async () => {
  assert.equal(await agent.parseSmartHealth("{}"), null)
  assert.equal(await agent.parseSmartHealth("{}"), null)
  assert.equal(await agent.parseSmartHealth("not json"), null)
  assert.equal(await agent.parseSmartHealth(""), null)
})

test("collectSmartMap stitches the scan with per-device queries", { skip }, async () => {
  const calls = []
  const run = async args => {
    calls.push(args.join(" "))
    if (args[0] === "--scan") return await readFixture("scan.json")
    if (args.includes("/dev/sda")) return await readFixture("sata-healthy.json")
    if (args.includes("/dev/nvme0")) return await readFixture("nvme-media-errors.json")
    return null
  }
  const map = await agent.collectSmartMap({ platform: "linux", run })
  assert.equal(map.size, 2)
  assert.equal(map.get("/dev/sda").passed, true)
  assert.equal(map.get("/dev/sda").powerOnHours, 15322)
  assert.equal(map.get("/dev/nvme0").mediaErrors, 3)
  assert.equal(calls[0], "--scan --json")
  assert.deepEqual(calls.slice(1).sort(), ["-H -A -j /dev/nvme0", "-H -A -j /dev/sda"])
})

test("collectSmartMap degrades to null without smartctl or off Linux", { skip }, async () => {
  const failing = async () => null
  assert.equal(await agent.collectSmartMap({ platform: "linux", run: failing }), null)
  const run = async () => await readFixture("scan.json")
  assert.equal(await agent.collectSmartMap({ platform: "darwin", run }), null)
})

test("collectSmartMap skips devices whose query returns no JSON", { skip }, async () => {
  const run = async args => {
    if (args[0] === "--scan") return await readFixture("scan.json")
    if (args.includes("/dev/sda")) return "not json"
    return null
  }
  assert.equal(await agent.collectSmartMap({ platform: "linux", run }), null)
})

test("attachSmartToDisks matches by whole-disk device", { skip }, () => {
  const disks = [
    { mount: "/", used: 10, total: 100, device: "/dev/sda" },
    { mount: "/data", used: 20, total: 100, device: "/dev/sdb" },
    { mount: "/nas", used: 30, total: 100, device: null },
  ]
  const smartMap = new Map([
    ["/dev/sda", { passed: true, temp: 38 }],
    ["/dev/sdb", { passed: false, temp: 52 }],
  ])
  const merged = agent.attachSmartToDisks(disks, smartMap)
  assert.equal(merged[0].smart.passed, true)
  assert.equal(merged[1].smart.passed, false)
  assert.equal(merged[2].smart, undefined)
  // 不修改原数组元素
  assert.equal(disks[0].smart, undefined)
  assert.deepEqual(agent.attachSmartToDisks(disks, null), disks)
})
