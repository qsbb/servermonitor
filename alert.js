// 阈值告警策略模块（纯函数，无 IO）：规则归一化、静默时段、状态机。
// 数据提取与通知发送在 model.js / index.js，本模块只负责“该不该报警”。

export const ALERT_METRICS = [
  "cpu_usage",
  "mem_usage",
  "disk_usage",
  "gpu_usage",
  "gpu_temp",
  "smart_failed",
]

const ALERT_METRIC_SET = new Set(ALERT_METRICS)

export const ALERT_METRIC_LABELS = {
  cpu_usage: "CPU 使用率",
  mem_usage: "内存使用率",
  disk_usage: "磁盘使用率",
  gpu_usage: "GPU 占用率",
  gpu_temp: "GPU 温度",
  smart_failed: "磁盘 SMART",
}

const MAX_RULES = 32

// 规则字段：metric / threshold / for(秒) / cooldown(秒) / enabled。
// 非法项直接丢弃，避免一条坏配置让整个配置解析失败。
export function normalizeAlertRules(input) {
  const list = Array.isArray(input) ? input : []
  const out = []
  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const metric = String(item.metric || "").trim()
    if (!ALERT_METRIC_SET.has(metric)) continue
    const threshold = Number(item.threshold)
    if (!Number.isFinite(threshold)) continue
    const hold = Number(item.for ?? item.duration ?? 0)
    const cooldown = Number(item.cooldown)
    const rule = {
      metric,
      threshold: Math.max(0, Math.min(100000, threshold)),
      for: Number.isFinite(hold) ? Math.max(0, Math.min(3600, Math.round(hold))) : 0,
      cooldown: Number.isFinite(cooldown) && cooldown > 0 ? Math.max(30, Math.min(86400, Math.round(cooldown))) : null,
      enabled: item.enabled === undefined ? true : !["0", "false", "off", "no"].includes(String(item.enabled).trim().toLowerCase()),
    }
    out.push(rule)
    if (out.length >= MAX_RULES) break
  }
  return out
}

// 规则状态按内容寻址：改了阈值/持续时长就是一条新规则，旧状态自然失效。
export function ruleKey(rule) {
  return `${rule.metric}:${rule.threshold}:${rule.for}`
}

// "23:00-08:00" / "12:00-13:30,23:00-07:00" → [{start,end}]（分钟，支持跨午夜）
export function parseQuietHours(text) {
  const ranges = []
  for (const part of String(text || "").split(",")) {
    const match = part.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
    if (!match) continue
    const startHour = Number(match[1])
    const startMinute = Number(match[2])
    const endHour = Number(match[3])
    const endMinute = Number(match[4])
    if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) continue
    const start = startHour * 60 + startMinute
    const end = endHour * 60 + endMinute
    // 起止相同视为非法段（否则会变成全天静默）
    if (start === end) continue
    ranges.push({ start, end })
  }
  return ranges
}

// 含 start、不含 end；start > end 表示跨午夜。
export function inQuietHours(ranges, date = new Date()) {
  if (!Array.isArray(ranges) || !ranges.length) return false
  const minutes = date.getHours() * 60 + date.getMinutes()
  return ranges.some(({ start, end }) => {
    if (start < end) return minutes >= start && minutes < end
    return minutes >= start || minutes < end
  })
}

// 单条规则的状态迁移。返回 nextStates（纯对象，可序列化）。
// 事件类型：fire（触发通知）、recover（恢复通知）；静默期间不产生事件，
// 但状态照常推进，静默结束后由 suppressed 标记补发一次。
export function evaluateAlertRules({
  rules = [],
  metrics = {},
  states = {},
  now = Date.now(),
  quiet = false,
  defaultCooldown = 120,
} = {}) {
  const nextStates = {}
  const events = []
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue
    const key = ruleKey(rule)
    const prev = states[key] || {}
    const st = {
      since: Number(prev.since) || 0,
      fired: Boolean(prev.fired),
      lastFiredAt: Number(prev.lastFiredAt) || 0,
      suppressed: Boolean(prev.suppressed),
    }
    const value = metrics[rule.metric]
    const hasValue = value !== null && value !== undefined && Number.isFinite(Number(value))
    const condition = hasValue && Number(value) >= Number(rule.threshold)
    const cooldownMs = Math.max(30, Number(rule.cooldown ?? defaultCooldown) || 120) * 1000
    // lastFiredAt=0 表示从未触发过，不能被当成“很久以前触发”而挡掉首次告警
    const cooldownReady = !st.lastFiredAt || now - st.lastFiredAt >= cooldownMs

    if (!condition) {
      if (st.fired) {
        st.fired = false
        st.since = 0
        const wasSuppressed = st.suppressed
        st.suppressed = false
        if (!quiet && !wasSuppressed) events.push({ type: "recover", rule, key, value: hasValue ? Number(value) : null })
      } else {
        st.since = 0
      }
    } else if (st.fired && st.suppressed) {
      if (!quiet) {
        st.suppressed = false
        st.lastFiredAt = now
        events.push({ type: "fire", rule, key, value: Number(value), resumed: true })
      }
    } else if (!st.fired) {
      if (!st.since) st.since = now
      const requiredMs = Math.max(0, Number(rule.for) || 0) * 1000
      if (now - st.since >= requiredMs) {
        if (quiet) {
          st.fired = true
          st.suppressed = true
        } else if (cooldownReady) {
          st.fired = true
          st.lastFiredAt = now
          events.push({ type: "fire", rule, key, value: Number(value) })
        }
      }
    }
    nextStates[key] = st
  }
  return { events, states: nextStates }
}

// 只保留当前规则表里存在的状态，避免配置删改后状态无限增长。
export function pruneAlertStates(states = {}, rules = []) {
  const keys = new Set((rules || []).map(ruleKey))
  const out = {}
  for (const [key, state] of Object.entries(states || {})) {
    if (keys.has(key)) out[key] = state
  }
  return out
}
