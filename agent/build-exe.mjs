#!/usr/bin/env node
// 把 agent.mjs 打包成单文件 exe。
// 注意：pkg 5.x 不支持 ESM 入口，所以先用 esbuild 把 agent.mjs + 依赖打成 CJS，
// 再把 CJS 交给 pkg；同时 agent.mjs 里不能出现顶层 await。
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(here, "..", "dist")
const bundleFile = path.join(distDir, "agent.cjs")
const target = process.env.PKG_TARGET || "node18-win-x64"
const output = process.env.EXE_OUTPUT
  || path.join(distDir, target.includes("win") ? "servermonitor-agent.exe" : "servermonitor-agent")

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", cwd: here })
  if (result.status !== 0) {
    console.error(`[build-exe] command failed: ${command} ${args.join(" ")}`)
    process.exit(result.status ?? 1)
  }
}

fs.mkdirSync(distDir, { recursive: true })

run("npx", [
  "--yes",
  "esbuild@0.21.5",
  "agent.mjs",
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--target=node18",
  "--define:import.meta.url=importMetaUrl",
  "--banner:js=const importMetaUrl=require('url').pathToFileURL(__filename).href;",
  `--outfile=${bundleFile}`,
])

run("npx", ["--yes", "pkg@5.8.1", bundleFile, "--targets", target, "--output", output])

console.log(`[build-exe] built ${output}`)
