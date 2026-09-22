import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const MODULE_FILES = ["config.js", "model.js", "local.js"]

export function basicConfig(extra = "") {
  return [
    "admins: []",
    "servers: []",
    "trusted_proxies: []",
    "report_enabled: true",
    "page_size: 8",
    "offline_timeout: 30",
    "public_status: false",
    "include_local: false",
    "alert:",
    "  enabled: false",
    "  cooldown: 120",
    "render:",
    "  imgType: png",
    extra,
  ].filter(Boolean).join("\n") + "\n"
}

export async function runInTempRepo({ config = basicConfig(), files = {}, script }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "servermonitor-test-"))
  try {
    for (const file of MODULE_FILES) {
      await fs.copyFile(path.join(REPO_ROOT, file), path.join(dir, file))
    }
    if (config !== null) await fs.writeFile(path.join(dir, "config.yaml"), config, "utf8")
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(dir, name)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, content, "utf8")
    }
    await fs.writeFile(path.join(dir, "scenario.mjs"), script, "utf8")

    const child = spawn(process.execPath, ["scenario.mjs"], { cwd: dir })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", chunk => { stdout += chunk })
    child.stderr.on("data", chunk => { stderr += chunk })
    const code = await new Promise(resolve => child.on("close", resolve))
    const line = stdout.split("\n").find(item => item.startsWith("__RESULT__"))
    const result = line ? JSON.parse(line.slice("__RESULT__".length)) : null
    return { code, stdout, stderr, result }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export function responseStub() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.payload = payload; return this },
  }
}

export function requestStub({ token = "", body = {}, ip = "127.0.0.1", headers = {} } = {}) {
  return {
    headers,
    ip,
    socket: { remoteAddress: ip },
    body,
    get(name) { return name.toLowerCase() === "x-sm-token" ? token : "" },
  }
}
