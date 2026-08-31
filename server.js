import { handleReport } from "./model.js"

const REPORT_ROUTES = ["/servermonitor/report", "/server-monitor/report"]
const MAX_BODY_BYTES = 256 * 1024

function ensureArray(target, key) {
  if (!target[key]) target[key] = []
  return target[key]
}

function registerOnce() {
  globalThis.__servermonitorReportHandler = handleReport
  if (!globalThis.Bot?.express) return false
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
