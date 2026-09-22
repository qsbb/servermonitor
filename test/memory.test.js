import test from "node:test"
import assert from "node:assert/strict"
import { decorateEntry, isEmptySnapshot, resolveMemoryUsage, sanitizeSnapshot } from "../model.js"
import { getLinuxMemAvailableBytes, parseLinuxMemAvailable } from "../local.js"

function makeRecord(mem) {
  return {
    snap: {
      cpu: { model: "test", cores: 1, usage: 0, temp: null, power: null },
      mem,
      disks: [],
      gpus: [],
      net: null,
      os: { platform: "linux", hostname: "test", uptime: 60 },
      load: [0, 0, 0],
    },
    lastSeen: 1_000,
    state: "online",
  }
}

test("uses available memory for pressure, text, color, and severity", () => {
  const memory = resolveMemoryUsage({ used: 2.36, total: 3.32, available: 2.64 })
  assert.equal(memory.source, "available")
  assert.ok(Math.abs(memory.effectiveUsed - 0.68) < 1e-12)

  const entry = decorateEntry({ name: "linux" }, makeRecord({
    used: 2.36,
    total: 3.32,
    available: 2.64,
    swapUsed: 0,
    swapTotal: 2,
  }), 1_000, 30_000)

  assert.ok(Math.abs(entry.memPct - 20.48192771084337) < 1e-9)
  assert.equal(entry.memText, "0.7GB / 3.3GB")
  assert.equal(entry.memSource, "available")
  assert.equal(entry.memAvailable, 2.64)
  assert.equal(entry.memColor, "#22c55e")
  assert.equal(entry.borderColor, "#22c55e")
  assert.ok(Math.abs(entry.rank - entry.memPct) < 1e-9)
  assert.equal(entry.swapText, "0.0GB / 2.0GB")
})

test("falls back to used for old agents and third-party reports", () => {
  const snapshot = sanitizeSnapshot({
    v: 1,
    mem: { used: 2.36, total: 3.32 },
  })
  assert.deepEqual(snapshot.mem, {
    used: 2.36,
    total: 3.32,
    available: null,
    swapUsed: null,
    swapTotal: null,
  })
  assert.equal(isEmptySnapshot(snapshot), false)

  const entry = decorateEntry({ name: "legacy" }, makeRecord(snapshot.mem), 1_000, 30_000)
  assert.ok(Math.abs(entry.memPct - 71.08433734939759) < 1e-9)
  assert.equal(entry.memText, "2.4GB / 3.3GB")
  assert.equal(entry.memSource, "used")
})

test("handles available memory boundaries without falling back", () => {
  assert.deepEqual(resolveMemoryUsage({ used: 4, total: 16, available: 0 }), {
    used: 4,
    total: 16,
    available: 0,
    effectiveUsed: 16,
    effectiveAvailable: 0,
    source: "available",
  })
  assert.equal(resolveMemoryUsage({ used: 4, total: 16, available: 16 }).effectiveUsed, 0)
  assert.deepEqual(resolveMemoryUsage({ used: 4, total: 16, available: 17 }), {
    used: 4,
    total: 16,
    available: 16,
    effectiveUsed: 0,
    effectiveAvailable: 16,
    source: "available",
  })
})

test("sanitizes invalid memory values and accepts numeric strings", () => {
  assert.deepEqual(resolveMemoryUsage({ used: "20", total: "16", available: "4" }), {
    used: 16,
    total: 16,
    available: 4,
    effectiveUsed: 12,
    effectiveAvailable: 4,
    source: "available",
  })
  assert.equal(resolveMemoryUsage({ used: -1, total: 16 }).effectiveUsed, null)
  assert.equal(resolveMemoryUsage({ used: 4, total: 16, available: -1 }).effectiveUsed, 4)
  assert.equal(resolveMemoryUsage({ used: 1, total: 0 }).effectiveUsed, null)
  assert.equal(resolveMemoryUsage({ used: "nope", total: 16 }).effectiveUsed, null)
  assert.equal(resolveMemoryUsage({ used: 1, total: -1 }).total, null)
})

test("keeps CPU, disk, and GPU severity behavior unchanged", () => {
  const record = makeRecord({ used: 1, total: 16, available: 15 })
  record.snap.cpu.usage = 42
  record.snap.disks = [{ mount: "/", used: 8, total: 10 }]
  record.snap.gpus = [{ model: "test", usage: 65 }]
  const entry = decorateEntry({ name: "mixed" }, record, 1_000, 30_000)
  assert.equal(entry.cpuPct, 42)
  assert.equal(entry.memPct, 6.25)
  assert.equal(entry.disks[0].pct, 80)
  assert.equal(entry.gpus[0].pct, 65)
  assert.equal(entry.rank, 80)
  assert.equal(entry.borderColor, "#fbbf24")
})

test("parses Linux MemAvailable in kB as bytes", () => {
  assert.equal(parseLinuxMemAvailable("MemTotal: 4096 kB\nMemAvailable: 2048 kB\n"), 2_097_152)
  assert.equal(parseLinuxMemAvailable("MemTotal: 4096 kB\n"), null)
  assert.equal(parseLinuxMemAvailable("MemAvailable: invalid kB\n"), null)
})

test("Linux available-memory reader is tolerant and platform-scoped", async () => {
  const readFile = async (file, encoding) => {
    assert.equal(file, "/proc/meminfo")
    assert.equal(encoding, "utf8")
    return "MemAvailable: 1024 kB\n"
  }
  assert.equal(await getLinuxMemAvailableBytes({ platform: "linux", readFile }), 1_048_576)
  assert.equal(await getLinuxMemAvailableBytes({ platform: "darwin", readFile }), null)
  assert.equal(await getLinuxMemAvailableBytes({
    platform: "linux",
    readFile: async () => { throw new Error("unavailable") },
  }), null)
})
