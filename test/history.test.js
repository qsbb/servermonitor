import test from "node:test"
import assert from "node:assert/strict"
import {
  DAY_MS,
  HOUR_MS,
  aggregatePoints,
  buildTrendData,
  createHistorySeries,
  fitHistoryToBudget,
  historyByteSize,
  ingestPoint,
  pruneHistoryServers,
  scalePoints,
} from "../history.js"

const LIMITS = { rawHours: 6, hourlyDays: 7, dailyDays: 90 }

test("aggregatePoints averages values and keeps bucket peaks", () => {
  const bucket = 3_600_000
  const aggregated = aggregatePoints([
    { t: bucket + 1000, c: 10, cMax: 10, m: 40, rx: 1, g: null },
    { t: bucket + 2000, c: 30, cMax: 55, m: 60, rx: 3, g: 12 },
    { t: bucket + 3000, c: 20, cMax: 20, m: null, rx: 2, g: 8 },
  ], bucket)
  assert.equal(aggregated.t, bucket)
  assert.equal(aggregated.c, 20)
  assert.equal(aggregated.cMax, 55)
  assert.equal(aggregated.m, 50)
  assert.equal(aggregated.rx, 2)
  assert.equal(aggregated.g, 10)
  assert.equal(aggregated.gMax, 12)
  // 缺样本不按 0 平均
  assert.equal(aggregatePoints([], bucket), null)
})

test("ingestPoint aggregates completed hours and days", () => {
  const t0 = 10 * DAY_MS + 5 * HOUR_MS
  let series = createHistorySeries()
  // 同一小时内两个点（尚未完成整点，不聚合）
  series = ingestPoint(series, { t: t0, c: 10 }, t0, LIMITS)
  series = ingestPoint(series, { t: t0 + 60_000, c: 30 }, t0 + 60_000, LIMITS)
  assert.equal(series.raw.length, 2)
  assert.equal(series.hourly.length, 0)

  // 进入下一小时：上一小时被聚合
  const nextHour = 10 * DAY_MS + 6 * HOUR_MS + 1000
  series = ingestPoint(series, { t: nextHour, c: 50 }, nextHour, LIMITS)
  assert.equal(series.hourly.length, 1)
  assert.equal(series.hourly[0].t, 10 * DAY_MS + 5 * HOUR_MS)
  assert.equal(series.hourly[0].c, 20)
  assert.equal(series.hourly[0].cMax, 30)
  // 已聚合的原始点仍在窗口内
  assert.ok(series.raw.length >= 1)
})

test("ingestPoint trims raw points outside the window and caps buckets", () => {
  const now = 50 * DAY_MS
  let series = createHistorySeries()
  // 注入 10 小时前的点：窗口 rawHours=6 应被裁剪
  series = ingestPoint(series, { t: now - 10 * HOUR_MS, c: 10 }, now, { rawHours: 6, hourlyDays: 7, dailyDays: 90 })
  assert.equal(series.raw.length, 0)
  // 连续多天数据，daily 上限生效
  for (let day = 0; day < 5; day++) {
    const ts = now - (day + 1) * DAY_MS
    series = ingestPoint(series, { t: ts, c: 10 }, now, { rawHours: 6, hourlyDays: 7, dailyDays: 2 })
  }
  assert.ok(series.daily.length <= 2)
})

test("fitHistoryToBudget shrinks oversized stores under the limit", () => {
  const series = { raw: [], hourly: [], daily: [] }
  for (let i = 0; i < 800; i++) series.raw.push({ t: i * 30_000, c: 10, m: 20, rx: 1, tx: 1, g: null })
  for (let i = 0; i < 200; i++) series.hourly.push({ t: i * HOUR_MS, c: 10, cMax: 20, m: 20, mMax: 30 })
  for (let i = 0; i < 90; i++) series.daily.push({ t: i * DAY_MS, c: 10, m: 20 })
  const store = { v: 1, savedAt: 1, series: { n1: series } }
  const before = historyByteSize(store)
  const fitted = fitHistoryToBudget(store, Math.floor(before / 3))
  assert.ok(historyByteSize(fitted) <= Math.floor(before / 3))
  // 原始入参不被修改
  assert.equal(store.series.n1.raw.length, 800)
})

test("pruneHistoryServers drops removed servers", () => {
  const store = { v: 1, savedAt: 1, series: { a: { raw: [], hourly: [], daily: [] }, b: { raw: [], hourly: [], daily: [] } } }
  const pruned = pruneHistoryServers(store, ["a"])
  assert.deepEqual(Object.keys(pruned.series), ["a"])
})

test("scalePoints draws a path and reports the last value", () => {
  const scaled = scalePoints([
    { t: 0, v: 0 },
    { t: 1000, v: 50 },
    { t: 2000, v: 100 },
  ], { max: 100 })
  assert.match(scaled.path, /^M[\d.]+,[\d.]+ L[\d.]+,[\d.]+ L[\d.]+,[\d.]+$/)
  assert.equal(scaled.last, 100)
  assert.equal(scaled.count, 3)

  const empty = scalePoints([], { max: 100 })
  assert.equal(empty.path, "")
  assert.equal(empty.count, 0)
})

test("buildTrendData returns empty state without points", () => {
  const data = buildTrendData({ name: "n1", series: createHistorySeries(), range: "24h" })
  assert.equal(data.empty, true)
  assert.equal(data.charts.length, 0)
  assert.equal(data.rangeLabel, "24 小时")
})

test("buildTrendData builds percent and network charts from hourly points", () => {
  const now = 20 * DAY_MS
  const hourly = []
  for (let i = 0; i < 12; i++) {
    hourly.push({
      t: now - (11 - i) * HOUR_MS,
      c: 20 + i,
      cMax: 30 + i,
      m: 50,
      mMax: 60,
      rx: 1 + i * 0.1,
      rxMax: 2,
      tx: 0.5,
      txMax: 1,
      g: i % 2 === 0 ? 10 : null,
      gMax: 20,
    })
  }
  const data = buildTrendData({ name: "n1", series: { raw: [], hourly, daily: [] }, range: "24h", now })
  assert.equal(data.empty, false)
  assert.equal(data.charts.length, 3)
  const [cpu, mem, net] = data.charts
  assert.equal(cpu.key, "cpu")
  assert.equal(cpu.yMax, 100)
  assert.equal(cpu.lines.length, 2)
  assert.equal(cpu.lines[0].label, "均值")
  assert.equal(cpu.lines[1].label, "峰值")
  assert.equal(mem.key, "mem")
  assert.equal(net.key, "net")
  assert.equal(net.lines[0].label, "下载")
  assert.equal(net.lines[1].label, "上传")
  assert.ok(net.yMax > 0)
  assert.match(data.summary, /CPU 均值/)
  assert.equal(data.xTicks.length, 5)
})

test("buildTrendData switches buckets by range", () => {
  const now = 100 * DAY_MS
  const daily = [{ t: now - 2 * DAY_MS, c: 30, cMax: 40, m: 50, mMax: 55, rx: 1, rxMax: 2, tx: 0.5, txMax: 1, g: null, gMax: null }]
  const data = buildTrendData({ name: "n1", series: { raw: [], hourly: [], daily }, range: "30d", now })
  assert.equal(data.empty, false)
  assert.equal(data.rangeLabel, "30 天")
  // 24h 只看 hourly，应视为空
  const hourlyEmpty = buildTrendData({ name: "n1", series: { raw: [], hourly: [], daily }, range: "24h", now })
  assert.equal(hourlyEmpty.empty, true)
})
