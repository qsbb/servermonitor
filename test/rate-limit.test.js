import test from "node:test"
import assert from "node:assert/strict"
import { resolveClientIp, state, sweepRateLimits } from "../model.js"

function req(remoteAddress, forwarded) {
  return {
    headers: forwarded ? { "x-forwarded-for": forwarded } : {},
    socket: { remoteAddress },
  }
}

test("untrusted peers cannot spoof X-Forwarded-For", () => {
  assert.equal(resolveClientIp(req("127.0.0.1", "203.0.113.9"), []), "127.0.0.1")
  assert.equal(resolveClientIp(req("::ffff:127.0.0.1", "203.0.113.9"), []), "127.0.0.1")
})

test("trusted proxies resolve the right-most untrusted address", () => {
  assert.equal(resolveClientIp(req("127.0.0.1", "203.0.113.9"), ["127.0.0.1"]), "203.0.113.9")
  assert.equal(
    resolveClientIp(req("127.0.0.1", "203.0.113.9, 10.0.0.5"), ["127.0.0.1", "10.0.0.5"]),
    "203.0.113.9",
  )
  assert.equal(resolveClientIp(req("127.0.0.1", "10.0.0.5, 10.0.0.5"), ["127.0.0.1", "10.0.0.5"]), "127.0.0.1")
})

test("rate limit sweep removes expired keys and enforces a hard cap", () => {
  state.reportRate.clear()
  state.reportRate.set("expired", { count: 1, resetAt: Date.now() - 1000 })
  state.reportRate.set("alive", { count: 1, resetAt: Date.now() + 60_000 })
  sweepRateLimits()
  assert.equal(state.reportRate.has("expired"), false)
  assert.equal(state.reportRate.has("alive"), true)

  for (let i = 0; i < 10_050; i++) {
    state.reportRate.set(`key-${i}`, { count: 1, resetAt: Date.now() + 60_000 + i })
  }
  sweepRateLimits()
  assert.ok(state.reportRate.size <= 10_000)
  state.reportRate.clear()
})
