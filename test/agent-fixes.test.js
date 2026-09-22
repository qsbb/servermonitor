import test from "node:test"
import assert from "node:assert/strict"

let agent = null
let importError = null
try {
  agent = await import("../agent/agent.mjs")
} catch (err) {
  importError = err
}
const skip = agent ? false : `agent dependencies unavailable: ${importError?.message || importError}`

test("agent module can be imported without running the collector", { skip }, () => {
  assert.equal(typeof agent.firstNonEmpty, "function")
  assert.equal(typeof agent.postSnapshot, "function")
})

test("normalizeVram converts systeminformation MB values to GB", { skip }, () => {
  assert.equal(agent.normalizeVram(256), 0.3)
  assert.equal(agent.normalizeVram(512), 0.5)
  assert.equal(agent.normalizeVram(1024), 1)
  assert.equal(agent.normalizeVram(8192), 8)
  assert.equal(agent.normalizeVram(0), 0)
  assert.equal(agent.normalizeVram(-1), null)
  assert.equal(agent.normalizeVram("nope"), null)
  assert.equal(agent.normalizeVram(2_000_000), null)
})

test("firstNonEmpty picks the first trimmed non-empty value", { skip }, () => {
  assert.equal(agent.firstNonEmpty(undefined, null, "", "  ", " first ", "second"), "first")
  assert.equal(agent.firstNonEmpty(undefined, null, 0), "0")
  assert.equal(agent.firstNonEmpty(undefined, null, ""), "")
})

test("postSnapshot requires a JSON body with ok=true", { skip }, async () => {
  const originalFetch = globalThis.fetch
  const payload = { v: 1, name: "node" }
  const respond = (status, body) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  })
  try {
    globalThis.fetch = respond(200, JSON.stringify({ ok: true, name: "node" }))
    assert.equal(await agent.postSnapshot("http://example.com/report", "sm_x", payload), true)

    globalThis.fetch = respond(202, JSON.stringify({ ok: true, pending: true }))
    assert.equal(await agent.postSnapshot("http://example.com/report", "sm_x", payload), true)

    globalThis.fetch = respond(200, "")
    await assert.rejects(() => agent.postSnapshot("http://example.com/report", "sm_x", payload), /invalid response/)

    globalThis.fetch = respond(200, JSON.stringify({ ok: false, msg: "rejected" }))
    await assert.rejects(() => agent.postSnapshot("http://example.com/report", "sm_x", payload), /invalid response/)

    globalThis.fetch = respond(500, JSON.stringify({ ok: false }))
    await assert.rejects(() => agent.postSnapshot("http://example.com/report", "sm_x", payload), /HTTP 500/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("filterDisks excludes container secret mounts and virtual filesystems", { skip }, () => {
  const gib = 1024 ** 3
  const disks = agent.filterDisks([
    { mount: "/etc/hosts", type: "ext4", used: gib, size: 10 * gib },
    { mount: "/etc/hostname", type: "ext4", used: gib, size: 10 * gib },
    { mount: "/etc/resolv.conf", type: "ext4", used: gib, size: 10 * gib },
    { mount: "/proc", type: "proc", used: gib, size: 10 * gib },
    { mount: "/host", type: "ext4", used: 50 * gib, size: 100 * gib },
    { mount: "/data", type: "ext4", used: 20 * gib, size: 100 * gib },
  ])
  assert.deepEqual(disks.map(item => item.mount).sort(), ["/", "/data"])
  const root = disks.find(item => item.mount === "/")
  assert.equal(root.used, 50)
  assert.equal(root.total, 100)
})

test("filterDisks drops macOS APFS system volumes that duplicate the root disk", { skip }, () => {
  const gib = 1024 ** 3
  const disks = agent.filterDisks([
    { mount: "/", type: "apfs", used: 120 * gib, size: 460 * gib },
    { mount: "/System/Volumes/Data", type: "apfs", used: 120 * gib, size: 460 * gib },
    { mount: "/System/Volumes/VM", type: "apfs", used: 4 * gib, size: 460 * gib },
    { mount: "/System/Volumes/Preboot", type: "apfs", used: 1 * gib, size: 460 * gib },
    { mount: "/Volumes/Backup", type: "hfs", used: 10 * gib, size: 500 * gib },
  ])
  assert.deepEqual(disks.map(item => item.mount), ["/", "/Volumes/Backup"])
})

test("filterDisks falls back to the macOS data volume when the root volume is missing", { skip }, () => {
  const gib = 1024 ** 3
  const disks = agent.filterDisks([
    { mount: "/System/Volumes/Data", type: "apfs", used: 120 * gib, size: 460 * gib },
    { mount: "/System/Volumes/VM", type: "apfs", used: 4 * gib, size: 460 * gib },
  ])
  assert.deepEqual(disks.map(item => item.mount), ["/"])
  assert.equal(disks[0].used, 120)
})

test("filterDisks collapses bind mounts that share a device and usage", { skip }, () => {
  const gib = 1024 ** 3
  const disks = agent.filterDisks([
    { mount: "/mnt/nas/a", fs: "/dev/sdb1", type: "ext4", used: 100 * gib, size: 400 * gib },
    { mount: "/mnt/nas/b", fs: "/dev/sdb1", type: "ext4", used: 100 * gib, size: 400 * gib },
    { mount: "/mnt/nas/c", fs: "/dev/sdb1", type: "ext4", used: 100 * gib, size: 400 * gib },
    { mount: "/data", fs: "/dev/sdc1", type: "ext4", used: 50 * gib, size: 200 * gib },
    { mount: "/mirror", fs: "/dev/sdd1", type: "ext4", used: 100 * gib, size: 400 * gib },
  ])
  assert.deepEqual(disks.map(item => item.mount).sort(), ["/data", "/mirror", "/mnt/nas/a"])
})

test("filterDisks collapses identical shares from the same file server", { skip }, () => {
  const gib = 1024 ** 3
  const disks = agent.filterDisks([
    { mount: "/mnt/nas/a", fs: "//192.168.5.88/Bot", type: "cifs", used: 100 * gib, size: 400 * gib },
    { mount: "/mnt/nas/b", fs: "//192.168.5.88/photo", type: "cifs", used: 100 * gib, size: 400 * gib },
    { mount: "/mnt/nas/c", fs: "//192.168.5.88/AI", type: "cifs", used: 20 * gib, size: 400 * gib },
    { mount: "/mnt/other", fs: "//192.168.5.99/backup", type: "cifs", used: 100 * gib, size: 400 * gib },
    { mount: "/mnt/nfs1", fs: "10.0.0.5:/export1", type: "nfs", used: 50 * gib, size: 200 * gib },
    { mount: "/mnt/nfs2", fs: "10.0.0.5:/export2", type: "nfs", used: 50 * gib, size: 200 * gib },
  ])
  assert.deepEqual(disks.map(item => item.mount).sort(), ["/mnt/nas/a", "/mnt/nas/c", "/mnt/nfs1", "/mnt/other"])
})

test("isLoopbackReportUrl only flags addresses that cannot leave the machine", { skip }, () => {
  assert.equal(agent.isLoopbackReportUrl("http://127.0.0.1:2536/servermonitor/report"), true)
  assert.equal(agent.isLoopbackReportUrl("http://localhost:2536/servermonitor/report"), true)
  assert.equal(agent.isLoopbackReportUrl("http://[::1]:2536/servermonitor/report"), true)
  assert.equal(agent.isLoopbackReportUrl("http://lingxiz.cn:2536/servermonitor/report"), false)
  assert.equal(agent.isLoopbackReportUrl("not a url"), false)
})

test("pickActiveInterface prefers the busiest non-virtual interface", { skip }, () => {
  assert.equal(agent.pickActiveInterface([]), null)
  assert.equal(
    agent.pickActiveInterface([
      { iface: "docker0", rx_bytes: 999999, tx_bytes: 999999 },
      { iface: "eth0", rx_bytes: 100, tx_bytes: 100 },
      { iface: "wlan0", rx_bytes: 500, tx_bytes: 500 },
    ]).iface,
    "wlan0",
  )
  assert.equal(
    agent.pickActiveInterface([{ iface: "lo", rx_bytes: 1, tx_bytes: 1 }]).iface,
    "lo",
  )
})

test("parses nvidia-smi values with locale decimal commas", { skip }, () => {
  assert.equal(agent.parseNvidiaNumber("35,03 W"), 35)
  assert.equal(agent.parseNvidiaNumber("35.03 W"), 35)
  assert.equal(agent.parseNvidiaNumber("12282"), 12282)
  assert.equal(agent.parseNvidiaNumber("62 %"), 62)
  assert.equal(agent.parseNvidiaNumber("[N/A]"), null)
  assert.equal(agent.parseNvidiaNumber("N/A"), null)
  assert.equal(agent.parseNvidiaNumber(""), null)
})

test("filters virtual display adapters but keeps real GPUs", { skip }, () => {
  const controllers = [
    { model: "GameViewer Virtual Display Adapter" },
    { model: "MuMu Virtual Display Adapter" },
    { model: "Meta Virtual Monitor" },
    { model: "Zako Display Adapter" },
    { model: "Microsoft Basic Display Adapter" },
    { model: "NVIDIA GeForce RTX 4070" },
    { model: "AMD Radeon(TM) Graphics" },
    { model: "Intel(R) Arc(TM) A770 Graphics" },
  ]
  assert.deepEqual(agent.filterGpuControllers(controllers).map(ctrl => ctrl.model), [
    "NVIDIA GeForce RTX 4070",
    "AMD Radeon(TM) Graphics",
    "Intel(R) Arc(TM) A770 Graphics",
  ])
  assert.equal(agent.isVirtualGpuName("Sunshine Virtual Display"), true)
  assert.equal(agent.isVirtualGpuName("Cirrus Logic GD 5446"), true)
  assert.equal(agent.isVirtualGpuName("Red Hat QXL controller"), true)
  assert.equal(agent.isVirtualGpuName("Standard VGA Graphics Adapter"), true)
  assert.equal(agent.isVirtualGpuName("Bochs Display Adapter"), true)
  assert.equal(agent.isVirtualGpuName("NVIDIA GeForce RTX 4070"), false)
})

test("treats >=4GiB AdapterRAM values as untrusted on Windows", { skip }, () => {
  assert.equal(agent.normalizeVram(4095, { windowsAdapterRam: true }), null)
  assert.equal(agent.normalizeVram(4095), 4)
  assert.equal(agent.normalizeVram(2048, { windowsAdapterRam: true }), 2)
  assert.equal(agent.normalizeVram(12282), 12)
})

test("parses Windows available-memory probe output", { skip }, () => {
  assert.equal(agent.parseWindowsAvailableMBytes("47550"), 47550)
  assert.equal(agent.parseWindowsAvailableMBytes("47550\r\n"), 47550)
  assert.equal(agent.parseWindowsAvailableMBytes(""), null)
  assert.equal(agent.parseWindowsAvailableMBytes("abc"), null)
})

test("collectNetwork returns an active interface on this host", { skip }, async () => {
  const net = await agent.collectNetwork()
  assert.ok(net, "expected a network entry (systeminformation needs a comma-joined interface list)")
  assert.equal(typeof net.iface, "string")
  assert.ok(net.iface.length > 0)
})

test("Docker disk usage follows df semantics (bfree, not bavail)", { skip }, () => {
  assert.deepEqual(agent.diskUsageFromStatfs({ blocks: 100, bfree: 40, bavail: 30, bsize: 1024 }), {
    total: 102400,
    used: 61440,
  })
  assert.equal(agent.diskUsageFromStatfs({}), null)
  assert.equal(agent.diskUsageFromStatfs({ blocks: 0, bfree: 0, bsize: 4096 }), null)
})

test("parseHostMounts keeps real filesystems and skips pseudo/duplicates", { skip }, () => {
  const sample = [
    "proc /proc proc rw 0 0",
    "tmpfs /run tmpfs rw 0 0",
    "overlay / overlay rw 0 0",
    "/dev/sda2 / ext4 rw 0 0",
    "/dev/sda1 /boot/efi vfat rw 0 0",
    "//192.168.5.88/AI /mnt/nas/AI cifs rw 0 0",
    "/dev/sda2 /mnt/bind ext4 rw 0 0",
    "/dev/nvme0n1p1 /ssd fuseblk rw 0 0",
    "fuse /tmp/fuse fuse rw 0 0",
  ].join("\n")
  assert.deepEqual(agent.parseHostMounts(sample), [
    { device: "/dev/sda2", mountpoint: "/", fstype: "ext4" },
    { device: "/dev/sda1", mountpoint: "/boot/efi", fstype: "vfat" },
    { device: "//192.168.5.88/AI", mountpoint: "/mnt/nas/AI", fstype: "cifs" },
    { device: "/dev/nvme0n1p1", mountpoint: "/ssd", fstype: "fuseblk" },
  ])
})

test("collectDiskLinuxDf maps explicit paths back to host mountpoints", { skip }, async () => {
  const rows = await agent.collectDiskLinuxDf(["/"])
  assert.ok(Array.isArray(rows) && rows.length >= 1)
  const root = rows.find(item => item.mount === "/")
  assert.ok(root && Number.isFinite(root.total) && root.total > 0)
})

test("hostMountPaths selects mappings visible inside the container", { skip }, () => {
  const mounts = [
    { device: "/dev/sda2", mountpoint: "/host", fstype: "ext4" },
    { device: "/dev/nvme0n1p1", mountpoint: "/host/ssd", fstype: "fuseblk" },
    { device: "//192.168.5.88/AI", mountpoint: "/host/mnt/nas/AI", fstype: "cifs" },
    { device: "proc", mountpoint: "/proc", fstype: "proc" },
    { device: "tmpfs", mountpoint: "/host/run", fstype: "tmpfs" },
  ]
  assert.deepEqual(agent.hostMountPaths(mounts), ["/host", "/host/ssd", "/host/mnt/nas/AI"])
})

test("hostMountPaths accepts both container and host mountpoint forms", { skip }, () => {
  const mounts = [
    { device: "/dev/sda2", mountpoint: "/", fstype: "ext4" },
    { device: "/dev/nvme0n1p1", mountpoint: "/ssd", fstype: "fuseblk" },
    { device: "//192.168.5.88/AI", mountpoint: "/mnt/nas/AI", fstype: "cifs" },
    { device: "tmpfs", mountpoint: "/run", fstype: "tmpfs" },
  ]
  assert.deepEqual(agent.hostMountPaths(mounts), ["/host", "/host/ssd", "/host/mnt/nas/AI"])
})

test("readHostMountsText falls back across candidate files", { skip }, async () => {
  const seen = []
  const text = await agent.readHostMountsText(async file => {
    seen.push(file)
    if (file === "/host/proc/1/mounts") throw new Error("missing")
    if (file === "/host/proc/mounts") return "/dev/sda2 /host ext4 rw 0 0\n"
    throw new Error("unexpected")
  })
  assert.equal(text, "/dev/sda2 /host ext4 rw 0 0\n")
  assert.deepEqual(seen, ["/host/proc/1/mounts", "/host/proc/mounts"])
})
