import { handleReport } from "./model.js"

const REPORT_ROUTES = ["/servermonitor/report", "/server-monitor/report"]
const MAX_BODY_BYTES = 256 * 1024

function ensureArray(target, key) {
  if (!target[key]) target[key] = []
  return target[key]
}

let warnedExpressPending = false

// 插件模块加载即调用（早于任何 task tick）。Bot.express 尚未就绪时提示：
// 这个窗口内 agent 上报会落到宿主 404 兜底，宿主日志会记录包含 X-SM-Token 的完整 headers。
function registerOnce() {
  globalThis.__servermonitorReportHandler = handleReport
  if (!globalThis.Bot?.express) {
    if (!warnedExpressPending) {
      warnedExpressPending = true
      const warn = globalThis.logger?.warn || console.warn
      warn("[servermonitor] Bot.express 尚未就绪，上报路由待注册；窗口内的上报请求会出现在 Yunzai 主日志中（含 token），插件加载完成后恢复静默")
    }
    return false
  }
  warnedExpressPending = false
  const app = Bot.express

  if (!app.__servermonitorRegistered) {
    app.__servermonitorRegistered = true
    const skipAuth = ensureArray(app, "skip_auth")
    const quiet = ensureArray(app, "quiet")
    for (const route of REPORT_ROUTES) {
      if (!skipAuth.includes(route)) skipAuth.push(route)
      if (!quiet.includes(route)) quiet.push(route)
    }

    for (const route of REPORT_ROUTES) {
      app.post(route, (req, res, next) => {
        const len = Number(req.headers["content-length"] || 0)
        if (len > MAX_BODY_BYTES) {
          return res.status(413).json({ ok: false, msg: "payload too large" })
        }
        return next()
      }, (req, res) => {
        return globalThis.__servermonitorReportHandler(req, res)
      })
    }
  }

  return true
}

registerOnce()

export function initServerMonitorRoutes() {
  return registerOnce()
}
