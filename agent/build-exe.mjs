#!/usr/bin/env node
// 打包单文件 exe。
// 注意两点：
//   1. pkg 5.x 不支持 ESM 入口，所以先用 esbuild 把 agent.mjs（含依赖）打成 CJS；
//   2. agent.mjs 里不能有顶层 await（CJS 打包不允许），主循环的定时器本身会保持进程存活。
// esbuild 用 Node API 调用，pkg 用 `node <cli>` 调用：全部绕开 shell，避免 Windows
// 批处理把 --banner 之类的参数拆坏（历史上就是在这里翻车）。
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(here, "..", "dist")
const bundleFile = path.join(distDir, "agent.cjs")
const target = process.env.PKG_TARGET || "node18-win-x64"
const output = process.env.EXE_OUTPUT
  || path.join(distDir, target.includes("win") ? "servermonitor-agent.exe" : "servermonitor-agent")

fs.mkdirSync(distDir, { recursive: true })

let esbuild
try {
  esbuild = await import("esbuild")
} catch {
  console.error("[build-exe] 缺少构建依赖，请先在 agent 目录执行 npm ci（esbuild/pkg 是 devDependencies）")
  process.exit(1)
}

await esbuild.build({
  entryPoints: [path.join(here, "agent.mjs")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  define: { "import.meta.url": "importMetaUrl" },
  banner: { js: 'const importMetaUrl=require("url").pathToFileURL(__filename).href;' },
  outfile: bundleFile,
  logLevel: "warning",
})

let pkgCli
try {
  pkgCli = require.resolve("pkg/lib-es5/bin.js")
} catch {
  console.error("[build-exe] 缺少 pkg，请先在 agent 目录执行 npm ci")
  process.exit(1)
}

const result = spawnSync(process.execPath, [pkgCli, bundleFile, "--targets", target, "--output", output], { stdio: "inherit" })
if (result.status !== 0) {
  console.error(`[build-exe] pkg 打包失败（退出码 ${result.status}）`)
  process.exit(result.status ?? 1)
}
console.log(`[build-exe] built ${output}`)
