import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// 用「相对路径 → 文本内容」的对象构造临时目录树，
// 供 sysfs 采集器、fixture 解析等测试使用。调用方负责 cleanup。
export async function buildFixtureTree(files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "servermonitor-fixture-"))
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, String(content))
  }
  return {
    root,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    },
  }
}
