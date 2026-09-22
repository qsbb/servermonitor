import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { detectExistingAgent, readAgentConfigFile } from "../scripts/install.mjs"

const TOKEN = `sm_${"a".repeat(32)}`

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "servermonitor-detect-"))
}

async function seedAgentDir(dir, config) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "agent.mjs"), 'console.log("agent")\n')
  if (config) {
    await fs.writeFile(path.join(dir, "servermonitor-agent.json"), JSON.stringify(config, null, 2))
  }
  return dir
}

async function withEnv(env, fn) {
  const saved = {}
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key]
    process.env[key] = env[key]
  }
  try {
    return await fn()
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

test("linux detection prefers the agent json over legacy unit Environment lines", async () => {
  const dir = await makeTempDir()
  const installDir = await seedAgentDir(path.join(dir, "opt", "servermonitor-agent"), {
    name: "web-01",
    token: TOKEN,
    reportUrl: "http://yunzai.example:2536/servermonitor/report",
    interval: 10,
    slowInterval: 30,
    timeout: 5000,
  })
  const serviceDir = path.join(dir, "systemd")
  await fs.mkdir(serviceDir, { recursive: true })
  await fs.writeFile(
    path.join(serviceDir, "servermonitor-agent.service"),
    '[Service]\nEnvironment="SM_NAME=legacy-01"\nEnvironment="SM_TOKEN=sm_legacy"\n',
  )

  const found = await withEnv({ INSTALL_DIR: installDir, SERVICE_DIR: serviceDir }, () => detectExistingAgent("linux-systemd"))
  assert.equal(found.kind, "Linux systemd")
  assert.equal(found.installDir, installDir)
  assert.equal(found.values.SM_NAME, "web-01")
  assert.equal(found.values.SM_TOKEN, TOKEN)
  assert.equal(found.values.SM_REPORT_URL, "http://yunzai.example:2536/servermonitor/report")
  assert.equal(found.values.SM_INTERVAL, "10")
})

test("linux detection still reads legacy unit Environment lines when no json exists", async () => {
  const dir = await makeTempDir()
  const installDir = await seedAgentDir(path.join(dir, "opt", "servermonitor-agent"), null)
  const serviceDir = path.join(dir, "systemd")
  await fs.mkdir(serviceDir, { recursive: true })
  await fs.writeFile(
    path.join(serviceDir, "servermonitor-agent.service"),
    '[Service]\nEnvironment="SM_NAME=legacy-01"\nEnvironment="SM_TOKEN=sm_legacy"\nEnvironment="SM_REPORT_URL=http://old:2536/servermonitor/report"\n',
  )

  const found = await withEnv({ INSTALL_DIR: installDir, SERVICE_DIR: serviceDir }, () => detectExistingAgent("linux-systemd"))
  assert.equal(found.values.SM_NAME, "legacy-01")
  assert.equal(found.values.SM_TOKEN, "sm_legacy")
  assert.equal(found.values.SM_REPORT_URL, "http://old:2536/servermonitor/report")
})

test("linux detection reports nothing when the service file is missing", async () => {
  const dir = await makeTempDir()
  const installDir = await seedAgentDir(path.join(dir, "opt", "servermonitor-agent"), { name: "web-01", token: TOKEN })
  const missing = await withEnv(
    { INSTALL_DIR: installDir, SERVICE_DIR: path.join(dir, "no-systemd") },
    () => detectExistingAgent("linux-systemd"),
  )
  assert.equal(missing, null)
})

test("macos detection prefers the agent json and falls back to the plist", async () => {
  const dir = await makeTempDir()
  const launchdDir = path.join(dir, "LaunchDaemons")
  await fs.mkdir(launchdDir, { recursive: true })
  await fs.writeFile(
    path.join(launchdDir, "com.servermonitor.agent.plist"),
    "<plist><dict><key>SM_NAME</key><string>plist-01</string><key>SM_TOKEN</key><string>sm_plist</string></dict></plist>",
  )
  const withJson = await seedAgentDir(path.join(dir, "opt", "servermonitor-agent"), { name: "mac-01", token: TOKEN })
  const fromJson = await withEnv({ INSTALL_DIR: withJson, LAUNCHD_DIR: launchdDir }, () => detectExistingAgent("macos"))
  assert.equal(fromJson.kind, "macOS launchd")
  assert.equal(fromJson.values.SM_NAME, "mac-01")
  assert.equal(fromJson.values.SM_TOKEN, TOKEN)

  const withoutJson = await seedAgentDir(path.join(dir, "opt2", "servermonitor-agent"), null)
  const fromPlist = await withEnv({ INSTALL_DIR: withoutJson, LAUNCHD_DIR: launchdDir }, () => detectExistingAgent("macos"))
  assert.equal(fromPlist.values.SM_NAME, "plist-01")
  assert.equal(fromPlist.values.SM_TOKEN, "sm_plist")
})

test("readAgentConfigFile returns null for a broken config file", async () => {
  const dir = await makeTempDir()
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "servermonitor-agent.json"), "{ not json")
  assert.equal(await readAgentConfigFile(dir), null)
  assert.equal(await readAgentConfigFile(path.join(dir, "missing")), null)
})
