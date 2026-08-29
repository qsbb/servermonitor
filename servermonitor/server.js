import { handleReport } from "./model.js"

const REPORT_ROUTES = ["/servermonitor/report", "/server-monitor/report"]
const QUIET_PREFIXES = ["/servermonitor", "/server-monitor"]

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
    const quiet = ensureArray(app, "quiet")
    const skipAuth = ensureArray(app, "skip_auth")

    for (const prefix of QUIET_PREFIXES) {
      if (!quiet.includes(prefix)) quiet.push(prefix)
      if (!skipAuth.includes(prefix)) skipAuth.push(prefix)
    }

    for (const route of REPORT_ROUTES) {
      app.post(route, (req, res) => {
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
