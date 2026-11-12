// 历史数据模块（纯函数，无 IO）：原始点采样 → 小时/天聚合 → 裁剪 → 趋势图数据。
// 存储结构见 docs/二期开发方案-beszel借鉴.md §4.6：
//   { v: 1, savedAt, series: { <name>: { raw: [], hourly: [], daily: [] } } }
// 点字段：t(ms) / c(CPU%) / m(内存%) / rx,tx(MB/s) / g(GPU%)，聚合点额外带 *Max 峰值。

export const HISTORY_VERSION = 1
export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS
export const MAX_HISTORY_BYTES = 4 * 1024 * 1024

export const DEFAULT_LIMITS = {
  rawHours: 6,
  hourlyDays: 7,
  dailyDays: 90,
}

export const TREND_RANGES = {
  "24h": { label: "24 小时", bucket: "hourly", spanMs: DAY_MS },
  "7d": { label: "7 天", bucket: "hourly", spanMs: 7 * DAY_MS },
  "30d": { label: "30 天", bucket: "daily", spanMs: 30 * DAY_MS },
}

const METRIC_KEYS = ["c", "m", "rx", "tx", "g"]

function round1(value) {
  return Number.isFinite(value) ? +value.toFixed(1) : null
}

function numbers(list) {
  return list.filter(value => Number.isFinite(value))
}

function average(list) {
  if (!list.length) return null
  return list.reduce((sum, value) => sum + value, 0) / list.length
}

export function normalizeHistoryLimits(input = {}) {
  const rawHours = Number(input.rawHours)
  const hourlyDays = Number(input.hourlyDays)
  const dailyDays = Number(input.dailyDays)
  return {
    rawHours: Number.isFinite(rawHours) ? Math.max(1, Math.min(72, rawHours)) : DEFAULT_LIMITS.rawHours,
    hourlyDays: Number.isFinite(hourlyDays) ? Math.max(1, Math.min(90, hourlyDays)) : DEFAULT_LIMITS.hourlyDays,
    dailyDays: Number.isFinite(dailyDays) ? Math.max(1, Math.min(365, dailyDays)) : DEFAULT_LIMITS.dailyDays,
  }
}

export function createHistorySeries() {
  return { raw: [], hourly: [], daily: [] }
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function cleanPoint(point) {
  const t = Number(point?.t)
  if (!Number.isFinite(t) || t <= 0) return null
  const out = { t }
  for (const key of METRIC_KEYS) {
    const value = toNumberOrNull(point?.[key])
    out[key] = value === null ? null : round1(value)
    const maxValue = toNumberOrNull(point?.[`${key}Max`])
    if (maxValue !== null) out[`${key}Max`] = round1(maxValue)
  }
  return out
}

// 把一段时间内的点聚合成一个桶：均值 + 峰值；缺样本的指标保持 null，不补 0。
export function aggregatePoints(points, bucketStart) {
  const list = (Array.isArray(points) ? points : []).map(cleanPoint).filter(Boolean)
  if (!list.length) return null
  const out = { t: bucketStart }
  for (const key of METRIC_KEYS) {
    const values = numbers(list.map(point => point[key]))
    out[key] = round1(average(values))
    const maxSource = numbers(list.map(point => (Number.isFinite(point[`${key}Max`]) ? point[`${key}Max`] : point[key])))
    out[`${key}Max`] = maxSource.length ? round1(Math.max(...maxSource)) : null
  }
  return out
}

function maxPointsFor(limits) {
  return {
    rawMax: Math.ceil(limits.rawHours * 3600 / 30),
    hourlyMax: Math.ceil(limits.hourlyDays * 24),
    dailyMax: Math.ceil(limits.dailyDays),
  }
}

// 写入一个原始点，并把已结束的小时/天滚动聚合。
export function ingestPoint(series, point, now = Date.now(), limitsInput = DEFAULT_LIMITS) {
  const limits = normalizeHistoryLimits(limitsInput)
  const maxes = maxPointsFor(limits)
  const clean = cleanPoint(point)
  const base = {
    raw: Array.isArray(series?.raw) ? series.raw : [],
    hourly: Array.isArray(series?.hourly) ? series.hourly : [],
    daily: Array.isArray(series?.daily) ? series.daily : [],
  }
  if (!clean) return { raw: [...base.raw], hourly: [...base.hourly], daily: [...base.daily] }

  const next = { raw: [...base.raw, clean], hourly: [...base.hourly], daily: [...base.daily] }

  const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS
  const currentDay = Math.floor(now / DAY_MS) * DAY_MS
  const lastHourly = next.hourly.length ? next.hourly[next.hourly.length - 1].t : 0
  const lastDaily = next.daily.length ? next.daily[next.daily.length - 1].t : 0

  // 聚合已结束的小时（只处理尚未聚合过的数据）
  const hourGroups = new Map()
  for (const item of next.raw) {
    if (item.t <= lastHourly || item.t >= currentHour) continue
    const bucket = Math.floor(item.t / HOUR_MS) * HOUR_MS
    if (!hourGroups.has(bucket)) hourGroups.set(bucket, [])
    hourGroups.get(bucket).push(item)
  }
  for (const [bucket, points] of [...hourGroups.entries()].sort((a, b) => a[0] - b[0])) {
    const aggregated = aggregatePoints(points, bucket)
    if (aggregated) next.hourly.push(aggregated)
  }
  next.hourly.sort((a, b) => a.t - b.t)

  // 聚合已结束的天（来源是小时桶）
  const dayGroups = new Map()
  for (const item of next.hourly) {
    if (item.t <= lastDaily || item.t >= currentDay) continue
    const bucket = Math.floor(item.t / DAY_MS) * DAY_MS
    if (!dayGroups.has(bucket)) dayGroups.set(bucket, [])
    dayGroups.get(bucket).push(item)
  }
  for (const [bucket, points] of [...dayGroups.entries()].sort((a, b) => a[0] - b[0])) {
    const aggregated = aggregatePoints(points, bucket)
    if (aggregated) next.daily.push(aggregated)
  }
  next.daily.sort((a, b) => a.t - b.t)

  // 裁剪：raw 只保留窗口内，各层再做点数上限兜底
  next.raw = next.raw.filter(item => now - item.t <= limits.rawHours * HOUR_MS).slice(-maxes.rawMax)
  next.hourly = next.hourly.slice(-maxes.hourlyMax)
  next.daily = next.daily.slice(-maxes.dailyMax)
  return next
}

export function historyByteSize(store) {
  try {
    return Buffer.byteLength(JSON.stringify(store || {}), "utf8")
  } catch {
    return 0
  }
}

// 超过上限时优先砍最旧的原始点，其次小时/天；返回新对象，不修改入参。
export function fitHistoryToBudget(store, maxBytes = MAX_HISTORY_BYTES) {
  let next = {
    v: HISTORY_VERSION,
    savedAt: Number(store?.savedAt) || Date.now(),
    series: {},
  }
  for (const [name, series] of Object.entries(store?.series || {})) {
    next.series[name] = {
      raw: Array.isArray(series?.raw) ? [...series.raw] : [],
      hourly: Array.isArray(series?.hourly) ? [...series.hourly] : [],
      daily: Array.isArray(series?.daily) ? [...series.daily] : [],
    }
  }
  let guard = 0
  while (historyByteSize(next) > maxBytes && guard < 80) {
    guard += 1
    let shrunk = false
    for (const series of Object.values(next.series)) {
      if (series.raw.length > 24) {
        series.raw = series.raw.slice(-Math.max(24, Math.floor(series.raw.length * 0.6)))
        shrunk = true
      } else if (series.hourly.length > 12) {
        series.hourly = series.hourly.slice(-Math.max(12, Math.floor(series.hourly.length * 0.6)))
        shrunk = true
      } else if (series.daily.length > 7) {
        series.daily = series.daily.slice(-Math.max(7, Math.floor(series.daily.length * 0.6)))
        shrunk = true
      }
    }
    if (!shrunk) break
  }
  return next
}

// 只保留配置里仍存在的服务器，避免删机后历史无限累积。
export function pruneHistoryServers(store, keepNames = []) {
  const keep = new Set((keepNames || []).map(String))
  const series = {}
  for (const [name, value] of Object.entries(store?.series || {})) {
    if (keep.has(name)) series[name] = value
  }
  return { v: HISTORY_VERSION, savedAt: Number(store?.savedAt) || Date.now(), series }
}

// 取趋势点：24h/7d 用小时桶，30d 用天桶。
export function selectTrendPoints(series, range, now = Date.now()) {
  const conf = TREND_RANGES[range] || TREND_RANGES["24h"]
  const points = Array.isArray(series?.[conf.bucket]) ? series[conf.bucket] : []
  return {
    conf,
    points: points.filter(point => Number.isFinite(point?.t) && point.t >= now - conf.spanMs),
  }
}

const CHART_WIDTH = 820
const CHART_HEIGHT = 170
const PAD_LEFT = 8
const PAD_RIGHT = 8
const PAD_TOP = 12
const PAD_BOTTOM = 14

function formatTrendTick(timestamp, range) {
  const date = new Date(timestamp)
  if (range === "24h") return `${String(date.getHours()).padStart(2, "0")}:00`
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function buildXTicks(points, range) {
  if (!points.length) return []
  const first = points[0].t
  const last = points[points.length - 1].t
  const span = Math.max(1, last - first)
  const count = 5
  const ticks = []
  for (let i = 0; i < count; i += 1) {
    const t = first + (span * i) / (count - 1)
    const x = PAD_LEFT + ((t - first) / span) * (CHART_WIDTH - PAD_LEFT - PAD_RIGHT)
    ticks.push({ x: +x.toFixed(1), label: formatTrendTick(t, range) })
  }
  return ticks
}

// 生成一条折线的 SVG path；返回 null 表示没有有效数据。
export function scalePoints(points = [], { width = CHART_WIDTH, height = CHART_HEIGHT, max = 100, min = 0 } = {}) {
  const span = Math.max(1, Number(max) - Number(min))
  const usableWidth = width - PAD_LEFT - PAD_RIGHT
  const usableHeight = height - PAD_TOP - PAD_BOTTOM
  const values = points.filter(point => Number.isFinite(point?.t) && Number.isFinite(point?.v))
  if (!values.length) return { path: "", last: null, count: 0 }
  const t0 = values[0].t
  const t1 = values[values.length - 1].t
  const timeSpan = Math.max(1, t1 - t0)
  const path = values
    .map((point, index) => {
      const x = PAD_LEFT + ((point.t - t0) / timeSpan) * usableWidth
      const clamped = Math.max(min, Math.min(max, point.v))
      const y = PAD_TOP + usableHeight - ((clamped - min) / span) * usableHeight
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(" ")
  return { path, last: values[values.length - 1].v, count: values.length }
}

function buildLine(points, key, maxKey, { label, color, dashed = false, max, min = 0 }) {
  const values = points
    .map(point => ({ t: point.t, v: Number(point[key]) }))
    .filter(point => Number.isFinite(point.v))
  const scaled = scalePoints(values, { max, min })
  if (!scaled.count) return null
  return { label, color, dashed, path: scaled.path, last: round1(scaled.last) }
}

function buildMaxLine(points, maxKey, { label, color, max, min = 0 }) {
  const values = points
    .map(point => ({ t: point.t, v: Number(point[maxKey]) }))
    .filter(point => Number.isFinite(point.v))
  const scaled = scalePoints(values, { max, min })
  if (!scaled.count) return null
  return { label, color: color || "#64748b", dashed: true, path: scaled.path, last: null }
}

function buildPercentChart({ key, title, unit, points, mainKey, maxKey, color }) {
  const lines = [
    buildLine(points, mainKey, maxKey, { label: "均值", color, max: 100 }),
    buildMaxLine(points, maxKey, { label: "峰值", color, max: 100 }),
  ].filter(Boolean)
  if (!lines.length) return null
  return {
    key,
    title,
    unit,
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    yMax: 100,
    yTicks: [
      { y: PAD_TOP, label: "100%" },
      { y: PAD_TOP + (CHART_HEIGHT - PAD_TOP - PAD_BOTTOM) / 2, label: "50%" },
      { y: CHART_HEIGHT - PAD_BOTTOM, label: "0%" },
    ],
    lines,
  }
}

function buildNetChart(points) {
  const rxMax = Math.max(0, ...numbers(points.map(point => Number(point.rxMax) || 0)), ...numbers(points.map(point => Number(point.rx) || 0)))
  const txMax = Math.max(0, ...numbers(points.map(point => Number(point.txMax) || 0)), ...numbers(points.map(point => Number(point.tx) || 0)))
  const peak = Math.max(rxMax, txMax, 0.1)
  // 纵轴取整到 1/2/5 的整数倍，避免刻度难以阅读
  const magnitude = Math.pow(10, Math.max(0, Math.floor(Math.log10(peak))))
  const yMax = Math.ceil(peak / magnitude) * magnitude
  const lines = [
    buildLine(points, "rx", "rxMax", { label: "下载", color: "#22d3ee", max: yMax }),
    buildLine(points, "tx", "txMax", { label: "上传", color: "#a78bfa", max: yMax }),
  ].filter(Boolean)
  if (!lines.length) return null
  const mid = yMax / 2
  return {
    key: "net",
    title: "网络速率",
    unit: "MB/s",
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    yMax,
    yTicks: [
      { y: PAD_TOP, label: `${yMax.toFixed(1)}` },
      { y: PAD_TOP + (CHART_HEIGHT - PAD_TOP - PAD_BOTTOM) / 2, label: `${mid.toFixed(1)}` },
      { y: CHART_HEIGHT - PAD_BOTTOM, label: "0" },
    ],
    lines,
  }
}

// 趋势图数据：供 art-template 直接渲染（纯 SVG，不依赖图表库）。
export function buildTrendData({ name = "", series = null, range = "24h", now = Date.now() } = {}) {
  const { conf, points } = selectTrendPoints(series, range, now)
  const base = {
    name,
    rangeLabel: conf.label,
    width: CHART_WIDTH,
    xTicks: [],
    charts: [],
    summary: "",
    empty: true,
  }
  if (!points.length) return base

  const charts = [
    buildPercentChart({ key: "cpu", title: "CPU 使用率", unit: "%", points, mainKey: "c", maxKey: "cMax", color: "#7aa2f7" }),
    buildPercentChart({ key: "mem", title: "内存使用率", unit: "%", points, mainKey: "m", maxKey: "mMax", color: "#22d3ee" }),
    buildNetChart(points),
  ].filter(Boolean)
  if (!charts.length) return base

  const last = points[points.length - 1]
  const avgC = round1(average(numbers(points.map(p => Number(p.c)))))
  const avgM = round1(average(numbers(points.map(p => Number(p.m)))))
  const summary = [
    avgC !== null ? `CPU 均值 ${avgC}%` : null,
    avgM !== null ? `内存均值 ${avgM}%` : null,
    Number.isFinite(Number(last.g)) && last.g !== null ? `GPU ${round1(Number(last.g))}%` : null,
  ].filter(Boolean).join(" · ")

  return {
    ...base,
    empty: false,
    summary: `${summary} · 共 ${points.length} 个记录点`,
    xTicks: buildXTicks(points, range),
    charts,
  }
}
