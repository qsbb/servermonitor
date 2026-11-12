import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { buildFixtureTree } from "./helpers/fs-fixture.mjs"

let agent = null
let importError = null
try {
  agent = await import("../agent/agent.mjs")
} catch (err) {
  importError = err
}
const skip = agent ? false : `agent dependencies unavailable: ${importError?.message || importError}`

const readFixture = async name =>
  JSON.parse(await fs.readFile(new URL(`./fixtures/sysfs/${name}`, import.meta.url), "utf8"))

test("parseSysfsNumber reads plain sysfs numbers and rejects junk", { skip }, () => {
  assert.equal(agent.parseSysfsNumber("37\n"), 37)
  assert.equal(agent.parseSysfsNumber(" 145000000 \n"), 145000000)
  assert.equal(agent.parseSysfsNumber("0x1002"), 0x1002)
  assert.equal(agent.parseSysfsNumber(""), null)
  assert.equal(agent.parseSysfsNumber("n/a"), null)
  assert.equal(agent.parseSysfsNumber(null), null)
})

test("normalizeGpuVendor maps PCI vendor ids", { skip }, () => {
  assert.equal(agent.normalizeGpuVendor("0x1002"), "amd")
  assert.equal(agent.normalizeGpuVendor("0x8086"), "intel")
  assert.equal(agent.normalizeGpuVendor("0x10DE"), null)
  assert.equal(agent.normalizeGpuVendor("AMD"), "amd")
  assert.equal(agent.normalizeGpuVendor(""), null)
  assert.equal(agent.normalizeGpuVendor(null), null)
})

test("gpuEntryFromSysfs converts AMD sysfs units", { skip }, () => {
  const { gpu } = agent.gpuEntryFromSysfs({
    vendor: "0x1002",
    busy: 37,
    vramUsed: 2 * 1024 ** 3,
    vramTotal: 8 * 1024 ** 3,
    tempMilli: 62000,
    powerMicroW: 145000000,
  })
  assert.equal(gpu.model, "AMD GPU")
  assert.equal(gpu.usage, 37)
  assert.equal(gpu.temp, 62)
  assert.equal(gpu.memUsed, 2)
  assert.equal(gpu.memTotal, 8)
  assert.equal(gpu.power, 145)
})

test("gpuEntryFromSysfs computes Intel power from an energy delta", { skip }, () => {
  const now = 1_000_000
  const first = agent.gpuEntryFromSysfs(
    { vendor: "0x8086", energyMicroJ: 4_000_000, tempMilli: 45000 },
    null,
    now,
  )
  // 第一次没有历史能量值，功耗未知
  assert.equal(first.gpu.power, null)
  assert.equal(first.gpu.model, "Intel GPU")
  assert.equal(first.gpu.temp, 45)

  const second = agent.gpuEntryFromSysfs(
    { vendor: "0x8086", energyMicroJ: 9_000_000, tempMilli: 45000 },
    { energyMicroJ: 4_000_000, at: now - 1000 },
    now,
  )
  // 5,000,000 µJ / 1s = 5W
  assert.equal(second.gpu.power, 5)

  // 采样间隔太短不参与差分
  const tooSoon = agent.gpuEntryFromSysfs(
    { vendor: "0x8086", energyMicroJ: 9_000_000 },
    { energyMicroJ: 4_000_000, at: now - 100 },
    now,
  )
  assert.equal(tooSoon.gpu.power, null)

  // 计数器回绕 / 复位（负增量）→ 无效
  const reset = agent.gpuEntryFromSysfs(
    { vendor: "0x8086", energyMicroJ: 1_000_000 },
    { energyMicroJ: 9_000_000, at: now - 1000 },
    now,
  )
  assert.equal(reset.gpu.power, null)
})

test("gpuEntryFromSysfs rejects out-of-range temperature", { skip }, () => {
  const hot = agent.gpuEntryFromSysfs({ vendor: "0x1002", tempMilli: 400000 }).gpu
  assert.equal(hot.temp, null)
  const nan = agent.gpuEntryFromSysfs({ vendor: "0x1002", tempMilli: Number.NaN }).gpu
  assert.equal(nan.temp, null)
})

test("collectGpuFromDrmSysfs reads an AMD card from a fake sysfs tree", { skip }, async () => {
  const fixture = await buildFixtureTree(await readFixture("amd-rx6600.json"))
  try {
    const gpus = await agent.collectGpuFromDrmSysfs({ root: fixture.root, platform: "linux", energyState: new Map() })
    assert.equal(gpus.length, 1)
    assert.deepEqual(gpus[0], {
      model: "AMD GPU",
      usage: 37,
      temp: 62,
      memUsed: 2,
      memTotal: 8,
      power: 145,
    })
  } finally {
    await fixture.cleanup()
  }
})

test("collectGpuFromDrmSysfs ignores non-main cards and non AMD/Intel vendors", { skip }, async () => {
  const fixture = await buildFixtureTree({
    "card0-VGA-1/device/vendor": "0x1002\n",
    "card0-VGA-1/device/gpu_busy_percent": "99\n",
    "card1/device/vendor": "0x10de\n",
    "card1/device/gpu_busy_percent": "88\n",
  })
  try {
    const gpus = await agent.collectGpuFromDrmSysfs({ root: fixture.root, platform: "linux", energyState: new Map() })
    assert.equal(gpus, null)
  } finally {
    await fixture.cleanup()
  }
})

test("collectGpuFromDrmSysfs tolerates missing files", { skip }, async () => {
  const fixture = await buildFixtureTree({ "card0/device/vendor": "0x1002\n" })
  try {
    const gpus = await agent.collectGpuFromDrmSysfs({ root: fixture.root, platform: "linux", energyState: new Map() })
    assert.equal(gpus.length, 1)
    assert.deepEqual(gpus[0], {
      model: "AMD GPU",
      usage: null,
      temp: null,
      memUsed: null,
      memTotal: null,
      power: null,
    })
  } finally {
    await fixture.cleanup()
  }
})

test("collectGpuFromDrmSysfs scans every hwmon dir instead of hardcoding one", { skip }, async () => {
  const fixture = await buildFixtureTree({
    "card0/device/vendor": "0x1002\n",
    "card0/device/hwmon/hwmon0/name": "amdgpu\n",
    "card0/device/hwmon/hwmon4/temp1_input": "55000\n",
  })
  try {
    const gpus = await agent.collectGpuFromDrmSysfs({ root: fixture.root, platform: "linux", energyState: new Map() })
    assert.equal(gpus[0].temp, 55)
  } finally {
    await fixture.cleanup()
  }
})

test("collectGpuFromDrmSysfs attaches lspci models only when counts match", { skip }, async () => {
  const amd = await readFixture("amd-rx6600.json")
  const intel = await readFixture("intel-uhd630.json")
  const fixture = await buildFixtureTree({ ...amd, ...intel })
  try {
    const matched = await agent.collectGpuFromDrmSysfs({
      root: fixture.root,
      platform: "linux",
      energyState: new Map(),
      models: ["AMD Radeon RX 6600", "Intel UHD 630"],
    })
    assert.deepEqual(matched.map(item => item.model), ["AMD Radeon RX 6600", "Intel UHD 630"])

    const mismatched = await agent.collectGpuFromDrmSysfs({
      root: fixture.root,
      platform: "linux",
      energyState: new Map(),
      models: ["AMD Radeon RX 6600"],
    })
    assert.deepEqual(mismatched.map(item => item.model), ["AMD GPU", "Intel GPU"])
  } finally {
    await fixture.cleanup()
  }
})

test("collectGpuFromDrmSysfs reuses Intel energy state across calls", { skip }, async () => {
  const fixture = await buildFixtureTree(await readFixture("intel-uhd630.json"))
  const state = new Map()
  try {
    const first = await agent.collectGpuFromDrmSysfs({ root: fixture.root, platform: "linux", now: 1_000_000, energyState: state })
    assert.equal(first[0].power, null)
    // 同一份 fixture 的 energy1_input 不变，1 秒后功耗应算出 0W 而不是报错
    const second = await agent.collectGpuFromDrmSysfs({ root: fixture.root, platform: "linux", now: 1_001_000, energyState: state })
    assert.equal(second[0].power, 0)
  } finally {
    await fixture.cleanup()
  }
})

test("collectGpuFromDrmSysfs is a no-op outside Linux", { skip }, async () => {
  const fixture = await buildFixtureTree(await readFixture("amd-rx6600.json"))
  try {
    assert.equal(await agent.collectGpuFromDrmSysfs({ root: fixture.root, platform: "darwin" }), null)
  } finally {
    await fixture.cleanup()
  }
})
