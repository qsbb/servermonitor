import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

async function writeExecutable(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, { mode: 0o755 })
  await fs.chmod(file, 0o755)
}

async function makeSandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "servermonitor-installer-"))
  const upstream = path.join(dir, "upstream")
  await fs.mkdir(path.join(upstream, "agent"), { recursive: true })
  await fs.writeFile(path.join(upstream, "agent", "agent.mjs"), 'console.log("new-agent")\n')
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: upstream })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: upstream })
  execFileSync("git", ["config", "user.name", "test"], { cwd: upstream })
  execFileSync("git", ["add", "-A"], { cwd: upstream })
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: upstream })

  const bin = path.join(dir, "bin")
  await writeExecutable(path.join(bin, "npm"), `#!/usr/bin/env bash
set -e
if [[ "\${STUB_NPM_FAIL:-0}" == "1" ]]; then echo "stub npm failure" >&2; exit 1; fi
mkdir -p node_modules/systeminformation
printf '%s' '{"name":"systeminformation","version":"0.0.0","main":"index.js"}' > node_modules/systeminformation/package.json
printf '%s' 'module.exports = {}' > node_modules/systeminformation/index.js
`)
  await writeExecutable(path.join(bin, "systemctl"), `#!/usr/bin/env bash
echo "systemctl $*" >> "\${STUB_SYSTEMCTL_LOG:?}"
if [[ "$1" == "is-active" ]]; then exit 0; fi
if [[ "$1" == "enable" && "$2" == "--now" ]]; then
  count=0
  [[ -f "\${STUB_ENABLE_COUNT:-}" ]] && count="$(cat "\${STUB_ENABLE_COUNT}")"
  count=$((count + 1))
  [[ -n "\${STUB_ENABLE_COUNT:-}" ]] && echo "$count" > "\${STUB_ENABLE_COUNT}"
  if [[ "\${STUB_FAIL_FIRST_ENABLE:-0}" == "1" && "$count" == "1" ]]; then exit 1; fi
fi
exit 0
`)
  await writeExecutable(path.join(bin, "launchctl"), `#!/usr/bin/env bash
echo "launchctl $*" >> "\${STUB_LAUNCHCTL_LOG:?}"
if [[ "$1" == "print" ]]; then exit 0; fi
if [[ "$1" == "kickstart" ]]; then
  count=0
  [[ -f "\${STUB_KICKSTART_COUNT:-}" ]] && count="$(cat "\${STUB_KICKSTART_COUNT}")"
  count=$((count + 1))
  [[ -n "\${STUB_KICKSTART_COUNT:-}" ]] && echo "$count" > "\${STUB_KICKSTART_COUNT}"
  if [[ "\${STUB_FAIL_FIRST_KICKSTART:-0}" == "1" && "$count" == "1" ]]; then exit 1; fi
fi
exit 0
`)
  return { dir, upstream, bin }
}

async function seedInstall(dir, agentText, config) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "agent.mjs"), agentText)
  await fs.writeFile(path.join(dir, "servermonitor-agent.json"), JSON.stringify(config, null, 2), { mode: 0o600 })
}

function runInstaller(script, sandbox, env) {
  return spawnSync("bash", [path.join(REPO_ROOT, script)], {
    cwd: sandbox.dir,
    env: {
      ...process.env,
      PATH: `${sandbox.bin}:${process.env.PATH}`,
      REPO_URL: `file://${sandbox.upstream}`,
      AUTO_GIT_MIRROR: "0",
      GIT_CLONE_ATTEMPTS: "1",
      SKIP_ROOT_CHECK: "1",
      HEALTH_CHECK_DELAY: "0",
      ...env,
    },
    encoding: "utf8",
  })
}

test("linux update stages the new agent and preserves the token", async () => {
  const sandbox = await makeSandbox()
  const installDir = path.join(sandbox.dir, "opt", "servermonitor-agent")
  const serviceDir = path.join(sandbox.dir, "systemd")
  await seedInstall(installDir, 'console.log("old-agent")\n', {
    name: "web-01",
    token: "sm_old_token",
    reportUrl: "http://old.example/servermonitor/report",
  })
  await fs.mkdir(serviceDir, { recursive: true })
  await fs.writeFile(path.join(serviceDir, "servermonitor-agent.service"), 'Environment="SM_TOKEN=sm_old_token"\n')
  const log = path.join(sandbox.dir, "systemctl.log")

  const result = runInstaller("scripts/install-agent-linux.sh", sandbox, {
    INSTALL_DIR: installDir,
    SERVICE_DIR: serviceDir,
    STUB_SYSTEMCTL_LOG: log,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(await fs.readFile(path.join(installDir, "agent.mjs"), "utf8"), /new-agent/)
  const config = JSON.parse(await fs.readFile(path.join(installDir, "servermonitor-agent.json"), "utf8"))
  assert.equal(config.token, "sm_old_token")
  assert.equal(config.name, "web-01")
  const unit = await fs.readFile(path.join(serviceDir, "servermonitor-agent.service"), "utf8")
  assert.doesNotMatch(unit, /SM_TOKEN|Environment=/)
  const calls = (await fs.readFile(log, "utf8")).trim().split("\n")
  assert.ok(calls.some(call => call.startsWith("systemctl stop ")))
  assert.ok(calls.some(call => call.startsWith("systemctl enable --now ")))
})

test("linux staging failure leaves the running service untouched", async () => {
  const sandbox = await makeSandbox()
  const installDir = path.join(sandbox.dir, "opt", "servermonitor-agent")
  const serviceDir = path.join(sandbox.dir, "systemd")
  await seedInstall(installDir, 'console.log("old-agent")\n', { name: "web-01", token: "sm_old_token", reportUrl: "http://old/report" })
  await fs.mkdir(serviceDir, { recursive: true })
  await fs.writeFile(path.join(serviceDir, "servermonitor-agent.service"), 'Environment="SM_TOKEN=sm_old_token"\n')
  const log = path.join(sandbox.dir, "systemctl.log")

  const result = runInstaller("scripts/install-agent-linux.sh", sandbox, {
    INSTALL_DIR: installDir,
    SERVICE_DIR: serviceDir,
    STUB_SYSTEMCTL_LOG: log,
    STUB_NPM_FAIL: "1",
  })
  assert.notEqual(result.status, 0)
  assert.match(await fs.readFile(path.join(installDir, "agent.mjs"), "utf8"), /old-agent/)
  const calls = (await fs.readFile(log, "utf8").catch(() => "")).trim()
  assert.doesNotMatch(calls, /systemctl stop/)
})

test("linux cutover failure rolls back to the previous agent", async () => {
  const sandbox = await makeSandbox()
  const installDir = path.join(sandbox.dir, "opt", "servermonitor-agent")
  const serviceDir = path.join(sandbox.dir, "systemd")
  await seedInstall(installDir, 'console.log("old-agent")\n', { name: "web-01", token: "sm_old_token", reportUrl: "http://old/report" })
  await fs.mkdir(serviceDir, { recursive: true })
  await fs.writeFile(path.join(serviceDir, "servermonitor-agent.service"), 'Environment="SM_TOKEN=sm_old_token"\n')
  const log = path.join(sandbox.dir, "systemctl.log")

  const result = runInstaller("scripts/install-agent-linux.sh", sandbox, {
    INSTALL_DIR: installDir,
    SERVICE_DIR: serviceDir,
    STUB_SYSTEMCTL_LOG: log,
    STUB_ENABLE_COUNT: path.join(sandbox.dir, "enable.count"),
    STUB_FAIL_FIRST_ENABLE: "1",
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /restoring previous installation/)
  assert.match(await fs.readFile(path.join(installDir, "agent.mjs"), "utf8"), /old-agent/)
  const calls = (await fs.readFile(log, "utf8")).trim().split("\n")
  assert.equal(calls.filter(call => call.startsWith("systemctl enable --now ")).length, 2)
})

test("macos update stages the new agent and strips secrets from the plist", async () => {
  const sandbox = await makeSandbox()
  const installDir = path.join(sandbox.dir, "opt", "servermonitor-agent")
  const launchdDir = path.join(sandbox.dir, "LaunchDaemons")
  await seedInstall(installDir, 'console.log("old-agent")\n', { name: "mac-01", token: "sm_old_token", reportUrl: "http://old/report" })
  await fs.mkdir(launchdDir, { recursive: true })
  const plist = path.join(launchdDir, "com.servermonitor.agent.plist")
  await fs.writeFile(plist, "<plist><dict><key>SM_TOKEN</key><string>sm_old_token</string></dict></plist>")
  const log = path.join(sandbox.dir, "launchctl.log")

  const result = runInstaller("scripts/install-agent-macos.sh", sandbox, {
    INSTALL_DIR: installDir,
    LAUNCHD_DIR: launchdDir,
    LOG_DIR: path.join(sandbox.dir, "logs"),
    STUB_LAUNCHCTL_LOG: log,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(await fs.readFile(path.join(installDir, "agent.mjs"), "utf8"), /new-agent/)
  const plistText = await fs.readFile(plist, "utf8")
  assert.doesNotMatch(plistText, /sm_old_token|EnvironmentVariables/)
  const config = JSON.parse(await fs.readFile(path.join(installDir, "servermonitor-agent.json"), "utf8"))
  assert.equal(config.token, "sm_old_token")
})

test("macos cutover failure rolls back to the previous agent", async () => {
  const sandbox = await makeSandbox()
  const installDir = path.join(sandbox.dir, "opt", "servermonitor-agent")
  const launchdDir = path.join(sandbox.dir, "LaunchDaemons")
  await seedInstall(installDir, 'console.log("old-agent")\n', { name: "mac-01", token: "sm_old_token", reportUrl: "http://old/report" })
  await fs.mkdir(launchdDir, { recursive: true })
  const plist = path.join(launchdDir, "com.servermonitor.agent.plist")
  await fs.writeFile(plist, "<plist><dict><key>SM_TOKEN</key><string>sm_old_token</string></dict></plist>")
  const log = path.join(sandbox.dir, "launchctl.log")

  const result = runInstaller("scripts/install-agent-macos.sh", sandbox, {
    INSTALL_DIR: installDir,
    LAUNCHD_DIR: launchdDir,
    LOG_DIR: path.join(sandbox.dir, "logs"),
    STUB_LAUNCHCTL_LOG: log,
    STUB_KICKSTART_COUNT: path.join(sandbox.dir, "kickstart.count"),
    STUB_FAIL_FIRST_KICKSTART: "1",
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /restoring previous installation/)
  assert.match(await fs.readFile(path.join(installDir, "agent.mjs"), "utf8"), /old-agent/)
})

test("installers prefer the official repo even when a mirror answers faster", async () => {
  const sandbox = await makeSandbox()
  const gitLog = path.join(sandbox.dir, "git-url.log")
  await writeExecutable(path.join(sandbox.bin, "git"), `#!/usr/bin/env bash
if [[ "$1" == "-C" ]]; then exec /usr/bin/git "$@"; fi
if [[ "$1" == "ls-remote" ]]; then
  url="\${@: -2:1}"
  if [[ "$url" == "https://github.com/qsbb/servermonitor.git" ]]; then sleep 0.4; fi
  exit 0
fi
if [[ "$1" == "clone" ]]; then
  url="\${@: -2:1}"
  dest="\${@: -1}"
  echo "$url" >> "\${STUB_GIT_LOG:?}"
  cp -a "\${STUB_UPSTREAM:?}" "$dest"
  exit 0
fi
exit 1
`)
  const installDir = path.join(sandbox.dir, "opt", "servermonitor-agent")
  const serviceDir = path.join(sandbox.dir, "systemd")
  await seedInstall(installDir, 'console.log("old-agent")\n', { name: "web-01", token: "sm_old_token", reportUrl: "http://old/report" })
  await fs.mkdir(serviceDir, { recursive: true })
  await fs.writeFile(path.join(serviceDir, "servermonitor-agent.service"), 'Environment="SM_TOKEN=sm_old_token"\n')

  const result = runInstaller("scripts/install-agent-linux.sh", sandbox, {
    INSTALL_DIR: installDir,
    SERVICE_DIR: serviceDir,
    STUB_SYSTEMCTL_LOG: path.join(sandbox.dir, "systemctl.log"),
    STUB_GIT_LOG: gitLog,
    STUB_UPSTREAM: sandbox.upstream,
    REPO_URL: "",
    AUTO_GIT_MIRROR: "1",
  })
  assert.equal(result.status, 0, result.stderr)
  const urls = (await fs.readFile(gitLog, "utf8")).trim().split("\n")
  assert.equal(urls[0], "https://github.com/qsbb/servermonitor.git")
})

test("a stale auto-selected mirror aborts before touching the service", async () => {
  const sandbox = await makeSandbox()
  const gitLog = path.join(sandbox.dir, "git-url.log")
  const gitCount = path.join(sandbox.dir, "git-count.txt")
  await writeExecutable(path.join(sandbox.bin, "git"), `#!/usr/bin/env bash
if [[ "$1" == "-C" ]]; then exec /usr/bin/git "$@"; fi
if [[ "$1" == "ls-remote" ]]; then
  url="\${@: -2:1}"
  n=0
  [[ -f "\${STUB_GIT_COUNT:?}" ]] && n="$(cat "\${STUB_GIT_COUNT}")"
  n=$((n + 1))
  echo "$n" > "\${STUB_GIT_COUNT}"
  if [[ "$url" == "https://github.com/qsbb/servermonitor.git" ]]; then
    if [[ "$n" == "1" ]]; then exit 1; fi
    sleep 0.3
    printf '%s\\t%s\\n' "\${STUB_OFFICIAL_SHA:?}" "refs/heads/main"
    exit 0
  fi
  exit 0
fi
if [[ "$1" == "clone" ]]; then
  url="\${@: -2:1}"
  dest="\${@: -1}"
  echo "$url" >> "\${STUB_GIT_LOG:?}"
  cp -a "\${STUB_UPSTREAM:?}" "$dest"
  exit 0
fi
exit 1
`)
  const installDir = path.join(sandbox.dir, "opt", "servermonitor-agent")
  const serviceDir = path.join(sandbox.dir, "systemd")
  await seedInstall(installDir, 'console.log("old-agent")\\n', { name: "web-01", token: "sm_old_token", reportUrl: "http://old/report" })
  await fs.mkdir(serviceDir, { recursive: true })
  await fs.writeFile(path.join(serviceDir, "servermonitor-agent.service"), 'Environment="SM_TOKEN=sm_old_token"\\n')
  const systemctlLog = path.join(sandbox.dir, "systemctl.log")

  const result = runInstaller("scripts/install-agent-linux.sh", sandbox, {
    INSTALL_DIR: installDir,
    SERVICE_DIR: serviceDir,
    STUB_SYSTEMCTL_LOG: systemctlLog,
    STUB_GIT_LOG: gitLog,
    STUB_GIT_COUNT: gitCount,
    STUB_UPSTREAM: sandbox.upstream,
    STUB_OFFICIAL_SHA: "0000000000000000000000000000000000000000",
    REPO_URL: "",
    AUTO_GIT_MIRROR: "1",
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /selected mirror is stale/)
  assert.match(await fs.readFile(path.join(installDir, "agent.mjs"), "utf8"), /old-agent/)
  const calls = await fs.readFile(systemctlLog, "utf8").catch(() => "")
  assert.doesNotMatch(calls, /systemctl stop/)
})

test("an unverifiable mirror proceeds with a warning", async () => {
  const sandbox = await makeSandbox()
  const gitLog = path.join(sandbox.dir, "git-url.log")
  await writeExecutable(path.join(sandbox.bin, "git"), `#!/usr/bin/env bash
if [[ "$1" == "-C" ]]; then exec /usr/bin/git "$@"; fi
if [[ "$1" == "ls-remote" ]]; then
  url="\${@: -2:1}"
  if [[ "$url" == "https://github.com/qsbb/servermonitor.git" ]]; then exit 1; fi
  exit 0
fi
if [[ "$1" == "clone" ]]; then
  url="\${@: -2:1}"
  dest="\${@: -1}"
  echo "$url" >> "\${STUB_GIT_LOG:?}"
  cp -a "\${STUB_UPSTREAM:?}" "$dest"
  exit 0
fi
exit 1
`)
  const installDir = path.join(sandbox.dir, "opt", "servermonitor-agent")
  const serviceDir = path.join(sandbox.dir, "systemd")
  await seedInstall(installDir, 'console.log("old-agent")\\n', { name: "web-01", token: "sm_old_token", reportUrl: "http://old/report" })
  await fs.mkdir(serviceDir, { recursive: true })
  await fs.writeFile(path.join(serviceDir, "servermonitor-agent.service"), 'Environment="SM_TOKEN=sm_old_token"\\n')

  const result = runInstaller("scripts/install-agent-linux.sh", sandbox, {
    INSTALL_DIR: installDir,
    SERVICE_DIR: serviceDir,
    STUB_SYSTEMCTL_LOG: path.join(sandbox.dir, "systemctl.log"),
    STUB_GIT_LOG: gitLog,
    STUB_UPSTREAM: sandbox.upstream,
    REPO_URL: "",
    AUTO_GIT_MIRROR: "1",
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /cannot verify mirror freshness/)
  assert.match(await fs.readFile(path.join(installDir, "agent.mjs"), "utf8"), /new-agent/)
})

test("installer rejects an unsafe INSTALL_DIR", async () => {
  const sandbox = await makeSandbox()
  const result = runInstaller("scripts/install-agent-linux.sh", sandbox, {
    INSTALL_DIR: "/",
    SM_NAME: "web-01",
    SM_REPORT_URL: "http://example.com/servermonitor/report",
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /INSTALL_DIR/)
})
