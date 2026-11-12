import test from "node:test"
import assert from "node:assert/strict"
import { sanitizeSnapshot, decorateEntry } from "../model.js"

function baseSnapshot(extra = {}) {
  return {
    v: 1,
    name: "n1",
    agent_ts: Date.now(),
    os: {},
    cpu: { usage: 10 },
    gpus: [],
    mem: { used: 1, total: 2 },
    net: {},
    disks: [],
    load: [0.1, 0.2, 0.3],
    ...extra,
  }
}

test("sanitizeSnapshot keeps valid health timestamps and clamps junk", () => {
  const now = Date.now()
  const snap = sanitizeSnapshot(baseSnapshot({ health: { fastAt: now - 1000, slowAt: String(now - 2000), smartAt: now + 60 * 60 * 1000 } }))
  assert.equal(snap.health.fastAt, now - 1000)
  assert.equal(snap.health.slowAt, now - 2000)
  // 未来一小时的时间戳不可信
  assert.equal(snap.health.smartAt, null)

  const empty = sanitizeSnapshot(baseSnapshot({ health: { fastAt: "n/a", slowAt: null } }))
  assert.equal(empty.health, null)
  assert.equal(sanitizeSnapshot(baseSnapshot()).health, null)
})

test("sanitizeSnapshot whitelists disk device and SMART fields", () => {
  const snap = sanitizeSnapshot(baseSnapshot({
    disks: [
      { mount: "/", used: 10, total: 100, device: "/dev/sda", smart: { passed: false, temp: 52, powerOnHours: 41200.6, reallocated: 8, pending: 2, extra: "drop" } },
      { mount: "/data", used: 10, total: 100, device: "C:", smart: { passed: "yes" } },
      { mount: "/bad", used: 10, total: 100, device: "/dev/../../etc", smart: { passed: true } },
    ],
  }))
  assert.equal(snap.disks[0].device, "/dev/sda")
  assert.deepEqual(snap.disks[0].smart, {
    passed: false,
    temp: 52,
    powerOnHours: 41201,
    reallocated: 8,
    pending: 2,
    mediaErrors: null,
  })
  // 非法设备名丢弃；smart 自身合法时仍保留（设备名只影响告警匹配）
  assert.equal(snap.disks[1].device, null)
  assert.equal(snap.disks[1].smart, null)
  assert.equal(snap.disks[2].device, null)
  assert.deepEqual(snap.disks[2].smart, {
    passed: true,
    temp: null,
    powerOnHours: null,
    reallocated: null,
    pending: null,
    mediaErrors: null,
  })
})

test("decorateEntry marks stale slow data from health.slowAt", () => {
  const now = Date.now()
  const record = {
    snap: baseSnapshot({ health: { fastAt: now - 1000, slowAt: now - 200_000 } }),
    lastSeen: now,
    state: "online",
    alertedAt: 0,
  }
  const entry = decorateEntry({ name: "n1", note: "" }, record, now, 30_000, { staleAfter: 90 })
  assert.equal(entry.slowStale, true)
  assert.equal(entry.fastStale, false)

  const fresh = decorateEntry({ name: "n1", note: "" }, { ...record, snap: baseSnapshot({ health: { fastAt: now - 1000, slowAt: now - 1000 } }) }, now, 30_000, { staleAfter: 90 })
  assert.equal(fresh.slowStale, false)

  // 0 表示关闭过期判定
  const disabled = decorateEntry({ name: "n1", note: "" }, record, now, 30_000, { staleAfter: 0 })
  assert.equal(disabled.slowStale, false)
})

test("decorateEntry falls back to agent_ts when health is missing", () => {
  const now = Date.now()
  const record = {
    snap: baseSnapshot({ agent_ts: now - 200_000 }),
    lastSeen: now,
    state: "online",
    alertedAt: 0,
  }
  const entry = decorateEntry({ name: "old-agent", note: "" }, record, now, 30_000, { staleAfter: 90 })
  assert.equal(entry.slowStale, true)
})

test("decorateEntry flags failing SMART disks", () => {
  const now = Date.now()
  const record = {
    snap: baseSnapshot({
      health: { fastAt: now, slowAt: now },
      disks: [
        { mount: "/", used: 10, total: 100, device: "/dev/sda", smart: { passed: true, temp: 38, powerOnHours: 100, reallocated: 0, pending: 0, mediaErrors: null } },
        { mount: "/data", used: 10, total: 100, device: "/dev/sdb", smart: { passed: false, temp: 52, powerOnHours: 200, reallocated: 8, pending: 2, mediaErrors: null } },
      ],
    }),
    lastSeen: now,
    state: "online",
    alertedAt: 0,
  }
  const entry = decorateEntry({ name: "n1", note: "" }, record, now, 30_000, { staleAfter: 90 })
  assert.equal(entry.hasSmartWarning, true)
  assert.match(entry.smartWarningText, /磁盘 SMART 告警/)
  assert.match(entry.smartWarningText, /重分配 8/)
  const failing = entry.disks.find(item => item.mount === "/data")
  assert.equal(failing.smartFailed, true)
  assert.match(failing.smartText, /SMART 告警/)
  const healthy = entry.disks.find(item => item.mount === "/")
  assert.equal(healthy.smartFailed, false)
  assert.match(healthy.smartText, /SMART 正常/)
})

test("decorateEntry stays quiet when SMART data is absent", () => {
  const now = Date.now()
  const record = {
    snap: baseSnapshot({ health: { fastAt: now, slowAt: now }, disks: [{ mount: "/", used: 10, total: 100 }] }),
    lastSeen: now,
    state: "online",
    alertedAt: 0,
  }
  const entry = decorateEntry({ name: "n1", note: "" }, record, now, 30_000, { staleAfter: 90 })
  assert.equal(entry.hasSmartWarning, false)
  assert.equal(entry.smartWarningText, "")
  assert.equal(entry.disks[0].smartText, "")
})
