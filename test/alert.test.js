import test from "node:test"
import assert from "node:assert/strict"
import {
  evaluateAlertRules,
  inQuietHours,
  normalizeAlertRules,
  parseQuietHours,
  pruneAlertStates,
  ruleKey,
} from "../alert.js"

const RULE = { metric: "cpu_usage", threshold: 90, for: 300, cooldown: 1800, enabled: true }

test("normalizeAlertRules keeps valid rules and drops junk", () => {
  const rules = normalizeAlertRules([
    { metric: "cpu_usage", threshold: 90, for: 300, cooldown: 600 },
    { metric: "mem_usage", threshold: "80" },
    { metric: "bogus", threshold: 1 },
    { metric: "disk_usage" },
    "nope",
    null,
    { metric: "gpu_temp", threshold: 85, for: 9999, cooldown: 5 },
    { metric: "smart_failed", threshold: 1, enabled: "false" },
  ])
  assert.equal(rules.length, 4)
  assert.deepEqual(rules[0], { metric: "cpu_usage", threshold: 90, for: 300, cooldown: 600, enabled: true })
  assert.equal(rules[1].cooldown, null)
  assert.equal(rules[1].for, 0)
  // for/cooldown 上限收敛
  assert.equal(rules[2].for, 3600)
  assert.equal(rules[2].cooldown, 30)
  assert.equal(rules[3].enabled, false)
})

test("parseQuietHours accepts cross-midnight ranges and drops invalid ones", () => {
  assert.deepEqual(parseQuietHours("23:00-08:00"), [{ start: 1380, end: 480 }])
  assert.deepEqual(parseQuietHours("12:00-13:30, 23:00-07:00"), [
    { start: 720, end: 810 },
    { start: 1380, end: 420 },
  ])
  assert.deepEqual(parseQuietHours(""), [])
  assert.deepEqual(parseQuietHours("25:00-08:00"), [])
  assert.deepEqual(parseQuietHours("23:00-23:00"), [])
  assert.deepEqual(parseQuietHours("garbage"), [])
})

test("inQuietHours handles normal and cross-midnight windows", () => {
  const at = (hour, minute = 0) => new Date(2026, 0, 1, hour, minute, 0)
  const night = parseQuietHours("23:00-08:00")
  assert.equal(inQuietHours(night, at(23, 30)), true)
  assert.equal(inQuietHours(night, at(2)), true)
  assert.equal(inQuietHours(night, at(7, 59)), true)
  // 含 start、不含 end
  assert.equal(inQuietHours(night, at(8)), false)
  assert.equal(inQuietHours(night, at(12)), false)
  const noon = parseQuietHours("12:00-13:30")
  assert.equal(inQuietHours(noon, at(12)), true)
  assert.equal(inQuietHours(noon, at(13, 29)), true)
  assert.equal(inQuietHours(noon, at(13, 30)), false)
  assert.equal(inQuietHours([], at(3)), false)
})

test("evaluateAlertRules fires only after the hold window", () => {
  const quiet = false
  const t0 = 1_000_000
  const first = evaluateAlertRules({ rules: [RULE], metrics: { cpu_usage: 95 }, states: {}, now: t0, quiet })
  assert.equal(first.events.length, 0)
  assert.equal(first.states[ruleKey(RULE)].since, t0)

  const early = evaluateAlertRules({ rules: [RULE], metrics: { cpu_usage: 95 }, states: first.states, now: t0 + 100_000, quiet })
  assert.equal(early.events.length, 0)

  const held = evaluateAlertRules({ rules: [RULE], metrics: { cpu_usage: 95 }, states: early.states, now: t0 + 300_000, quiet })
  assert.equal(held.events.length, 1)
  assert.equal(held.events[0].type, "fire")
  assert.equal(held.events[0].value, 95)
  assert.equal(held.states[ruleKey(RULE)].fired, true)
  assert.equal(held.states[ruleKey(RULE)].lastFiredAt, t0 + 300_000)

  // 持续触发期间不重复通知
  const again = evaluateAlertRules({ rules: [RULE], metrics: { cpu_usage: 96 }, states: held.states, now: t0 + 400_000, quiet })
  assert.equal(again.events.length, 0)
})

test("evaluateAlertRules recovers and honours cooldown", () => {
  const key = ruleKey(RULE)
  const fired = {
    [key]: { since: 1_000_000, fired: true, lastFiredAt: 1_300_000, suppressed: false },
  }
  const recovered = evaluateAlertRules({ rules: [RULE], metrics: { cpu_usage: 10 }, states: fired, now: 2_000_000, quiet: false })
  assert.equal(recovered.events.length, 1)
  assert.equal(recovered.events[0].type, "recover")
  assert.equal(recovered.states[key].fired, false)

  // 恢复后立刻再次触发：冷却未到，不通知但保持监视
  const retrigger = evaluateAlertRules({ rules: [RULE], metrics: { cpu_usage: 95 }, states: recovered.states, now: 2_100_000, quiet: false })
  assert.equal(retrigger.events.length, 0)
  assert.equal(retrigger.states[key].fired, false)
  assert.equal(retrigger.states[key].since, 2_100_000)

  // 冷却过后补发
  const afterCooldown = evaluateAlertRules({ rules: [RULE], metrics: { cpu_usage: 95 }, states: retrigger.states, now: 2_100_000 + 1_800_000, quiet: false })
  assert.equal(afterCooldown.events.length, 1)
  assert.equal(afterCooldown.events[0].type, "fire")
})

test("evaluateAlertRules suppresses notifications during quiet hours and resumes after", () => {
  const key = ruleKey(RULE)
  const quietStates = evaluateAlertRules({ rules: [RULE], metrics: { cpu_usage: 95 }, states: {}, now: 1_000_000, quiet: true })
  // for 300s，静默中推进状态但不发事件
  const held = evaluateAlertRules({ rules: [RULE], metrics: { cpu_usage: 95 }, states: quietStates.states, now: 1_400_000, quiet: true })
  assert.equal(held.events.length, 0)
  assert.equal(held.states[key].fired, true)
  assert.equal(held.states[key].suppressed, true)

  const resumed = evaluateAlertRules({ rules: [RULE], metrics: { cpu_usage: 95 }, states: held.states, now: 1_500_000, quiet: false })
  assert.equal(resumed.events.length, 1)
  assert.equal(resumed.events[0].type, "fire")
  assert.equal(resumed.events[0].resumed, true)
  assert.equal(resumed.states[key].suppressed, false)

  // 静默期间恢复：只清状态，不发送恢复通知
  const quietRecover = evaluateAlertRules({
    rules: [RULE],
    metrics: { cpu_usage: 10 },
    states: { [key]: { since: 1_000_000, fired: true, lastFiredAt: 1_000_000, suppressed: true } },
    now: 1_600_000,
    quiet: true,
  })
  assert.equal(quietRecover.events.length, 0)
  assert.equal(quietRecover.states[key].fired, false)
})

test("evaluateAlertRules treats smart_failed as a boolean threshold", () => {
  const rule = { metric: "smart_failed", threshold: 1, for: 0, cooldown: 600, enabled: true }
  const fired = evaluateAlertRules({ rules: [rule], metrics: { smart_failed: 1 }, states: {}, now: 5_000, quiet: false })
  assert.equal(fired.events.length, 1)
  const healthy = evaluateAlertRules({ rules: [rule], metrics: { smart_failed: 0 }, states: {}, now: 5_000, quiet: false })
  assert.equal(healthy.events.length, 0)
})

test("pruneAlertStates removes states for rules that no longer exist", () => {
  const kept = ruleKey(RULE)
  const pruned = pruneAlertStates(
    { [kept]: { fired: true }, "cpu_usage:99:0": { fired: true } },
    [RULE],
  )
  assert.deepEqual(Object.keys(pruned), [kept])
})
