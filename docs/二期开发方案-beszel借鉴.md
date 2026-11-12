# Servermonitor 二期开发方案（借鉴 beszel）

> 文档状态：已实现（M1–M4，2026-11-13；M5 发版待定）
> 编写日期：2026-11-13
> 基线版本：`v0.1.21`（commit `1fe2d88`）
> 目标版本：`v0.2.0`（minor）
>
> 落地提交：M1 `5169560`、M2 `af61e11`、M3 `20c7e2d`、M4 `9b0ad0e`。
> 与本文的差异：SMART 仅 Linux（Windows 需捆绑 smartctl，暂缓）；趋势图范围固定 24h/7d/30d，未做自定义区间。
> 参考项目：[beszel](https://github.com/henrygd/beszel)（MIT，Go，hub + agent + Web UI）
> 适用范围：`agent/agent.mjs`、`model.js`、`config.js`、`index.js`、`resources/*`、`test/*`

---

## 1. 背景与目标

### 1.1 现状盘点（v0.1.21）

| 能力 | 现状 | 说明 |
| --- | --- | --- |
| 采集 | Linux / macOS / Windows / Docker | `systeminformation` + `nvidia-smi` + sysfs 温度/功耗 + Windows GPU 性能计数器 |
| 显卡占用率 | NVIDIA 全覆盖；Windows 非 N 卡（AMD/Intel）已补 | **Linux 上 AMD / Intel 仍只有型号，无占用率/显存/温度/功耗** |
| 磁盘健康 | 无 | 只有 `df` 容量 |
| 告警 | 仅「离线 / 恢复」 | `model.js` `scanOffline()`，`alert.cooldown` |
| 历史数据 | 无 | `data/snapshots.json` 只保留最新快照 |
| 展示 | `#服务器状态` / `pro` / 详情 / 列表 | art-template + Chromium 截图 |
| 测试 | `node:test` 94 用例 | 已有 `parseDfOutput` 等纯函数测试 |

### 1.2 beszel 可借鉴点（已完成可行性分析）

| 借鉴项 | beszel 实现位置 | 我方价值 |
| --- | --- | --- |
| AMD / Intel GPU sysfs 采集 | `agent/gpu_amd_linux.go:188-212`、`agent/gpu_intel_sysfs_linux.go:143-190` | 高（补齐 Linux 非 N 卡） |
| SMART 磁盘健康 | `agent/smart.go`、`smart_nonwindows.go` | 高（磁盘故障预警） |
| 阈值告警 + 静默时段 | `internal/alerts/alerts.go:180-200` | 高（监控核心诉求） |
| 历史分层聚合 | `internal/records/records.go`（`AverageSystemStatsSlice`） | 高（从「看当下」到「看趋势」） |
| 采集器隔离与健康度 | `agent/connection_manager.go`、各 collector | 中（解释「为什么是 —」） |
| 解析器 fixture 测试 | `agent/test-data/*` | 中（防回归） |

### 1.3 二期目标

- **G1**：Linux 上 AMD / Intel 显卡补齐占用率、显存、温度、功耗。
- **G2**：上报快照携带采集健康度，界面区分「没这项数据」与「采集失败/过期」。
- **G3**：磁盘 SMART 健康接入（可选依赖，缺失静默降级）。
- **G4**：阈值告警（CPU/内存/磁盘/GPU/磁盘健康）+ 持续时长防抖 + 冷却 + 静默时段。
- **G5**：历史数据（原始 6h / 小时 7d / 天 90d）+ `#服务器状态趋势` 趋势图。
- **G6**：测试基建 fixture 化，新增解析器全部有纯函数测试。

### 1.4 非目标（明确不做）

- Web UI / 多用户 / OAuth / REST API（宿主是 Yunzai，身份与展示已解决）。
- WebSocket 长连接（10s 一次小 JSON POST 足够轻，改造成本与收益不匹配）。
- SSH 拉取模式（需要 Yunzai 侧管理 SSH 凭据，与推模式冲突）。
- S3 / 本地自动备份、ZFS/Btrfs 深度采集、容器级历史、电池、风扇（列为 P2 以后）。
- HMAC / 重放防护（已有设计草案，见 `docs/优化与诊断方案.md` §8，独立排期）。

---

## 2. 设计原则与约束

1. **协议向后兼容**：上报仍为 `v: 1`；新增字段全部可选，旧 agent 不报即缺失，插件按缺失处理。新插件收到旧格式不受影响。
2. **缺失降级，不伪造**：任何采集失败返回 `null`，界面显示 `—`，绝不填 0。
3. **插件零新增运行时依赖**：`package.json` 保持无 dependencies；仅使用 Node 内置模块 + 宿主已提供的 puppeteer。
4. **agent 新增外部命令必须可选**：`smartctl` 缺失时静默跳过，不报错、不阻塞。
5. **解析逻辑纯函数化**：所有解析器（sysfs 数值、smartctl JSON、静默时段、趋势坐标）导出纯函数，可直接测试。
6. **采集隔离**：沿用 `safe(fn, fallback, timeout)`，新增采集项单独超时，单项失败不影响整包。
7. **落盘收敛**：不新增定时器；历史采样复用现有 `servermonitor快照落盘`（`*/30 * * * * *`）任务。
8. **配置默认值兼容**：新配置项都有默认值；旧 `config.yaml` 直接可用；未知键仍按现有解析器行为忽略。
9. **可回滚**：每项功能独立配置开关（`history.enabled`、`alert.rules: []`、`SM_SMART=0`），任一功能可单独关闭。

---

## 3. 变更总览

### 3.1 文件清单

| 文件 | 类型 | 变更内容 |
| --- | --- | --- |
| `agent/agent.mjs` | 修改 | 新增 `collectGpuFromDrmSysfs`、`collectSmart`、健康度时间戳；`refreshSlow` 集成 |
| `model.js` | 修改 | `sanitizeSnapshot` 白名单扩展；`decorateEntry` 过期标记；告警评估接入；历史采样与聚合；`buildTrendData` |
| `config.js` | 修改 | 新增 `stale_after`、`alert.rules`、`alert.quiet_hours`、`history.*` 的解析/序列化/归一化 |
| `index.js` | 修改 | 新增 `#服务器状态趋势` 规则与处理函数；任务里调用历史落盘 |
| `resources/server_status.html` | 修改 | 过期标记样式与提示；磁盘健康徽标 |
| `resources/server_trend.html` | 新增 | 趋势图模板（纯 SVG） |
| `resources/status.css` | 修改 | `.sb-stale`、`.sb-badge-*`、`.tr-*` 样式 |
| `agent/README.md` | 修改 | `SM_SMART` 等环境变量 |
| `README.md` / `部署文档.md` / `开发文档.md` | 修改 | 新命令、新配置、新协议字段 |
| `test/fixtures/*` | 新增 | `nvidia-smi`、`smartctl`、sysfs 目录树、`df` 等样例 |
| `test/*.test.js` | 修改/新增 | 见各模块测试计划 |

### 3.2 协议字段新增（全部可选）

| 字段 | 类型 | 说明 | 上限 |
| --- | --- | --- | --- |
| `health.fastAt` | number(ms) | 快采集（CPU/内存/网络）完成时间 | 钳制到 `[now-365d, now+5min]` |
| `health.slowAt` | number(ms) | 慢采集（磁盘/温度/GPU/功耗）完成时间 | 同上 |
| `health.smartAt` | number\|null | SMART 最近成功采集时间 | 同上 |
| `disks[].device` | string | 整盘设备名（如 `/dev/nvme0n1`） | ≤ 64 字符，仅 `/dev/[a-z0-9]+` |
| `disks[].smart` | object\|null | SMART 健康数据 | 见下 |

`disks[].smart` 子字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `passed` | boolean\|null | `smartctl` 健康判定 |
| `temp` | number\|null | 摄氏度 |
| `powerOnHours` | number\|null | 通电小时 |
| `reallocated` | number\|null | 重分配扇区数（ATA id 5） |
| `pending` | number\|null | 待映射扇区（ATA id 197） |
| `mediaErrors` | number\|null | NVMe 介质错误 |

### 3.3 配置项新增

```yaml
# 采集健康度：慢采集超过多少秒视为过期（界面标灰）
stale_after: 90

alert:
  enabled: true
  cooldown: 120
  quiet_hours: ""        # 例："23:00-08:00" 或 "12:00-13:30,23:00-07:00"
  rules: []              # 为空 = 关闭阈值告警，行为与 v0.1.21 完全一致
  # 示例：
  # rules:
  #   - metric: cpu_usage
  #     threshold: 90
  #     for: 300
  #     cooldown: 1800
  #   - metric: mem_usage
  #     threshold: 90
  #     for: 300
  #     cooldown: 1800
  #   - metric: disk_usage
  #     threshold: 90
  #     for: 600
  #     cooldown: 3600
  #   - metric: gpu_temp
  #     threshold: 85
  #     for: 120
  #     cooldown: 1800
  #   - metric: smart_failed
  #     threshold: 1
  #     for: 0
  #     cooldown: 3600

history:
  enabled: true
  raw_hours: 6
  hourly_days: 7
  daily_days: 90
```

---

## 4. 详细设计

### 4.1 P0-1：Linux AMD / Intel GPU 采集

#### 4.1.1 现状

`agent/agent.mjs`：

- `collectGpuFromNvidiaSmi()` 只覆盖 NVIDIA。
- 失败后 `collectGpuFallback()` → Linux 走 `collectGpuFromLspci()`，只拿型号，`usage/temp/memUsed/memTotal/power` 全为 `null`。
- 温度/功耗已有 sysfs 读取模式（`readLinuxCpuTempFromSysfs`），可复用风格。

#### 4.1.2 sysfs 数据源（beszel 实测路径）

| 指标 | AMD | Intel |
| --- | --- | --- |
| 设备发现 | `/sys/class/drm/card*/device/vendor` = `0x1002` | `0x8086` |
| 占用率 | `device/gpu_busy_percent`（0-100） | `device/gpu_busy_percent`（部分内核/驱动有） |
| 显存已用 | `device/mem_info_vram_used`（字节） | 无（集成显存） |
| 显存总量 | `device/mem_info_vram_total`（字节） | 无 |
| 温度 | `device/hwmon/hwmon*/temp1_input`（毫摄氏度） | 同左 |
| 功耗 | `device/hwmon/hwmon*/power1_average`（微瓦；退化 `power1_input`） | `hwmon/hwmon*/energy1_input`（微焦，两次采样差分 ÷ 秒） |

要点：

- 必须遍历 `hwmon*`，不同内核/驱动编号不固定，不能硬编码 `hwmon0`。
- 忽略 `card0-VGA-1` 这类非主卡目录（文件名含 `-`）。
- 单位换算：`temp1_input / 1000`、`power1_average / 1e6`、Intel `energy1_input`（µJ）差分后 `/ 1e6` 得瓦特。
- Intel 功耗需要状态（上次能量值 + 时间），放入 `Collector` 实例字段（`this.intelEnergy = new Map()`）。

#### 4.1.3 实现接口

```js
// 纯函数：解析 sysfs 数值文本（容错换行/空白/单位后缀）
export function parseSysfsNumber(text) // → number | null

// 纯函数：由一个适配器的 sysfs 读取结果构造 GPU 条目
// data = { vendor: "amd"|"intel", busy, vramUsed, vramTotal, tempMilli, powerMicroW, energyMicroJ, now }
export function gpuEntryFromSysfs(data, prev) // → { gpu, energyState }

// 采集器：root 可注入，便于测试
export async function collectGpuFromDrmSysfs({ root = "/sys/class/drm", timeout = 3000, prev = null } = {})
// → [{ model: null, usage, temp, memUsed, memTotal, power }] | null
```

#### 4.1.4 合并策略（与 Windows 计数器同一原则）

1. `nvidia-smi` 成功 → 直接用（现状不变）。
2. 否则 `collectGpuFromDrmSysfs()`：
   - 若有 DRM 适配器，且 `lspci` 型号列表数量一致 → 按索引绑定型号（一一对应才绑定）。
   - 数量不一致 → `model` 用 `"AMD GPU"` / `"Intel GPU"`，不张冠李戴。
3. 都没有 → `collectGpuFromLspci()` 仅型号兜底（现状）。
4. 全部包在 `safe(..., [], 3000, "gpu-sysfs")`。

#### 4.1.5 测试计划（`test/agent-gpu-sysfs.test.js`）

- 临时目录构造假 sysfs 树：单 AMD 卡、单 Intel 卡、双卡、缺 `power1_average`、`gpu_busy_percent` 不存在。
- 断言：单位换算（毫度→度、微瓦→瓦、字节→GB）、缺失字段为 `null`、非主卡目录被忽略。
- Intel 能量差分：两次调用间隔 1s，能量差 5,000,000 µJ → 5W。
- 回归：NVIDIA 路径与 lspci 兜底不受影响。

#### 4.1.6 风险

| 风险 | 对策 |
| --- | --- |
| 内核版本差异导致路径不同 | 遍历 glob，逐项容错；缺失即 `null` |
| 多卡型号绑定错误 | 仅在数量一致时绑定 |
| 读取频率过高 | 跟随慢采集（默认 30s），不额外轮询 |

---

### 4.2 P0-2：采集健康度

#### 4.2.1 agent 侧

`Collector.refreshFast()` / `refreshSlow()` 成功后写入：

```js
this.health = { fastAt: Date.now(), slowAt: Date.now(), smartAt: this.health?.smartAt ?? null }
```

SMART 单独缓存周期（默认 600s），成功时更新 `smartAt`。快照输出新增 `health` 字段。

#### 4.2.2 插件侧

- `sanitizeSnapshot`：`health` 仅接受对象，三个时间戳各自 `numOrNull` 并钳制到 `[now-365d, now+5min]`，否则 `null`。
- `decorateEntry` 计算：

```js
const staleAfterMs = Math.max(30, Number(config.stale_after ?? 90)) * 1000
const slowAge = now - (snap.health?.slowAt || snap.agent_ts || record.lastSeen)
const slowStale = slowAge > staleAfterMs      // 磁盘/GPU/温度/功耗块
const fastAge = now - (snap.health?.fastAt || snap.agent_ts || record.lastSeen)
const fastStale = fastAge > staleAfterMs      // CPU/内存/网络块
```

- 输出 `entry.slowStale` / `entry.fastStale` / `entry.dataAgeText`（复用现有格式）。

#### 4.2.3 UI

- `server_status.html`：慢采集块加 `class="sb-block {{if s.slowStale}}sb-stale{{/if}}"`，CSS `.sb-stale { opacity: .55; }`，并显示小字「数据 N 秒前」。
- 概览卡片角标：仅当过期时显示 `⟳ 数据过期`。

#### 4.2.4 测试

- `sanitizeSnapshot`：缺 `health`、非法类型、未来时间 → 全部 `null`。
- `decorateEntry`：新鲜/过期/无时间戳三态，`stale_after: 0` 关闭。
- 模板渲染：过期块出现 `sb-stale` 类。

---

### 4.3 P0-3：测试基建 fixture 化

#### 4.3.1 目录

```text
test/
├── fixtures/
│   ├── nvidia-smi/
│   │   ├── single-rtx3060.txt
│   │   └── dual-gpu-cn-locale.txt      # 中文区域小数点逗号
│   ├── smartctl/
│   │   ├── sata-healthy.json
│   │   ├── sata-failing.json
│   │   ├── nvme-media-errors.json
│   │   └── scan.json
│   ├── df/
│   │   ├── linux-ext4.txt
│   │   └── docker-host.txt
│   └── sysfs/                           # 以「路径 → 内容」的 JS 对象描述，测试时落临时目录
│       ├── amd-rx6600.json
│       └── intel-uhd630.json
└── helpers/
    └── fs-fixture.mjs                   # buildSysfsFixture(files) → 临时根目录
```

#### 4.3.2 约定

- fixture 文件**只读**，测试不修改。
- 解析器签名统一 `parseXxx(text) → 数据 | null`，测试直接 `readFile + parse`。
- sysfs 类采集器接受 `{ root }` 注入，测试用临时目录。
- 现有 `parseDfOutput`、`parseWindowsAvailableMBytes` 等逐步迁移到 fixtures（渐进，不阻塞）。

#### 4.3.3 验收

每个新增解析器至少 3 条用例：正常、缺字段、脏数据。

---

### 4.4 P1-1：SMART 磁盘健康

#### 4.4.1 依赖与降级

- 需要 `smartmontools`。agent 启动时 `which smartctl`，缺失则 `SMART=false`，日志 `info` 一次，不重复告警。
- 容器 / 无权限（非 root）→ 读取失败即跳过。
- 配置：`SM_SMART=1|0`（默认 `1`）、`SM_SMART_INTERVAL=600`（秒，最小 60）。

#### 4.4.2 采集流程

```text
smartctl --scan --json            → devices[{name, type, protocol}]
for each device (最多 8 个，单盘超时 3s，总预算 15s):
    smartctl -H -A -j <name>      → 解析健康字段
缓存 600s
```

解析字段：

| 来源 | 字段 |
| --- | --- |
| `smart_status.passed` | 健康判定 |
| `temperature.current` | 温度 |
| `power_on_time.hours` | 通电小时 |
| `ata_smart_attributes.table[]` id=5 | `reallocated` |
| `ata_smart_attributes.table[]` id=197 | `pending` |
| `nvme_smart_health_information_log.media_errors` | `mediaErrors` |

#### 4.4.3 分区 → 整盘映射

- `parseDfOutput` 已输出 `fs` 字段（如 `/dev/sda2`、`/dev/nvme0n1p1`），`filterDisks` 当前丢弃 `fs`，需透传为 `device`。
- 规整规则：`/dev/sda2 → /dev/sda`、`/dev/nvme0n1p1 → /dev/nvme0n1`、`/dev/mmcblk0p1 → /dev/mmcblk0`。
- 同一整盘的所有分区挂载点共享同一份 SMART 数据。
- Windows / macOS：本期不采集 SMART（Windows 需捆绑 smartctl.exe，macOS 需 `smartctl` 且多数盘不支持），字段保持 `null`。

#### 4.4.4 插件侧

- `sanitizeSnapshot` 增加 `device`、`smart` 白名单与上限。
- 概览：任一磁盘 `smart.passed === false` → 卡片角标 `⚠ 磁盘告警`；详情页列出每盘健康、温度、通电小时。
- 告警：`smart_failed` 规则联动（4.5）。

#### 4.4.5 测试

- `parseSmartOutput(json)`：健康 SATA、故障 SATA（`passed: false`）、NVMe 介质错误、字段缺失。
- 设备规整：`normalizeBlockDevice()` 四种形态。
- 分区共享：同一 device 的多个挂载点拿到同一 smart。
- 降级：`smartctl` 不存在 / 超时 / 非 root（EACCES）→ 全 `null`，不影响其他字段。

#### 4.4.6 风险

| 风险 | 对策 |
| --- | --- |
| 权限/容器不可用 | 降级 + 文档注明 |
| smartctl 卡死（坏盘） | 单盘 3s 超时 + SIGKILL |
| 采集开销 | 600s 缓存，最多 8 盘 |

---

### 4.5 P1-2：阈值告警 + 静默时段

#### 4.5.1 数据与配置

见 3.3。规则指标白名单：

| metric | 取值 | 判定 |
| --- | --- | --- |
| `cpu_usage` | CPU % | `>= threshold` |
| `mem_usage` | 内存使用率 %（`resolveMemoryUsage`） | `>= threshold` |
| `disk_usage` | 所有挂载点中最大使用率 % | `>= threshold` |
| `gpu_usage` | 所有 GPU 中最大占用率 % | `>= threshold` |
| `gpu_temp` | 所有 GPU 中最高温度 | `>= threshold` |
| `smart_failed` | 任一磁盘 `smart.passed === false` | 布尔 |

#### 4.5.2 状态机（每服务器 × 每条规则）

```js
// 内存态，随 snapshots.json 持久化
{ since: 0, fired: false, lastFiredAt: 0, suppressed: false }
```

每个 `servermonitor离线扫描` tick（10s）：

```text
cond = 当前值满足阈值
if  !cond && fired:            → 进入恢复通知（受静默时段约束），fired=false, since=0
if   cond && since===0:        → since=now
if   cond && now-since >= for*1000 && !fired:
        if 处于静默时段:        → fired=true, suppressed=true（不发送）
        else if now-lastFiredAt >= cooldown: → 发送，fired=true, lastFiredAt=now
if   fired && suppressed && 离开静默时段 && cond:
        → 补发一次，suppressed=false, lastFiredAt=now
```

- 恢复通知同样遵守静默时段（避免半夜刷屏）。
- 同一 tick 内所有服务器的告警合并为**一条** `Bot.sendMasterMsg` 消息，避免消息风暴。
- `for: 0` 表示立即触发；`for` 上限 3600s。
- 规则变更后旧状态按 key 自然失效（key = `${metric}:${threshold}:${for}`），并定期清理不在配置中的 key。

#### 4.5.3 静默时段

```js
export function parseQuietHours(text)   // → [{ start: 1380, end: 480 }]（分钟，支持跨午夜）
export function inQuietHours(ranges, date) // → boolean
```

- 格式：`HH:MM-HH:MM`，多段逗号分隔；解析失败 → 视为空（不静默）并 `warn` 一次。
- 跨午夜：`start > end` 时区间为 `[start, 24*60) ∪ [0, end]`。
- 时区：使用宿主本地时间（Yunzai 所在机器）。

#### 4.5.4 持久化

`data/snapshots.json` payload 增加：

```json
{ "alerts": { "2c2g": { "cpu_usage:90:300": { "since": 0, "fired": true, "lastFiredAt": 1763000000000, "suppressed": false } } } }
```

- 加载时校验类型，非法丢弃。
- 服务器删除时同步清理（`removeServer`）。
- 大小上限：每服务器最多 32 条规则状态，超出丢弃最旧。

#### 4.5.5 测试（`test/alert-rules.test.js`）

- 阈值边界（89.9 / 90 / 90.1）。
- `for` 防抖：首次满足立即触发，未满 `for` 不触发，满足后触发。
- 冷却：冷却内不重复发送。
- 静默：跨午夜、多段、端点为开/闭区间（约定含 start、不含 end）。
- 恢复通知；静默期间恢复不发送；静默结束后补发。
- 规则变更后旧状态清理；空 rules 行为与 v0.1.21 一致。
- 多服务器合并成一条消息。

---

### 4.6 P1-3：历史数据与趋势

#### 4.6.1 存储模型

文件：`data/history.json`（0600，data 目录 0700，原子写）。

```json
{
  "v": 1,
  "savedAt": 1763000000000,
  "series": {
    "2c2g": {
      "raw":    [{ "t": 1763000000000, "c": 37.5, "m": 52.1, "rx": 1.2, "tx": 0.4, "g": 55 }],
      "hourly": [{ "t": 1762999200000, "c": 38.2, "cMax": 91.0, "m": 53.0, "mMax": 88.0, "rx": 2.1, "rxMax": 9.9, "tx": 0.6, "txMax": 3.1, "g": 51.0, "gMax": 99.0 }],
      "daily":  [{ "t": 1762905600000, "c": 36.0, "cMax": 95.0, "m": 52.0, "mMax": 90.0, "rx": 2.0, "rxMax": 12.0, "tx": 0.5, "txMax": 4.0, "g": 50.0, "gMax": 99.0 }]
    }
  }
}
```

字段缩写：`c`=CPU%、`m`=内存%、`rx/tx`=MB/s、`g`=GPU%；`*Max` 为桶内峰值（图形上沿）。

#### 4.6.2 采样与聚合

- 原始点：跟随 `servermonitor快照落盘`（30s）写入，保留 `raw_hours`（默认 6h → 720 点）。
- 小时桶：整点由原始点均值 + 峰值聚合，保留 `hourly_days`（默认 7d → 168 点）。
- 天桶：零点由小时桶聚合，保留 `daily_days`（默认 90d → 90 点）。
- 缺样本（离线）不补 0：桶内没有样本就不生成该桶（趋势图断线）。
- 仅在 `state === "online"` 且有 `snap` 时采样。

#### 4.6.3 容量控制

- 单点约 60–90 字节；16 台 × (720+168+90) ≈ 1.6 万点 ≈ 1.2–1.5 MB。
- 硬上限 `MAX_HISTORY_BYTES = 4 MB`：超过时按「最旧服务器 → 最旧点」顺序裁剪，并保留每台最近 24 个原始点。
- 读取损坏 → 备份为 `history.json.corrupt-<ts>` 并使用空历史，不阻塞插件启动。

#### 4.6.4 渲染

- 新命令：`#服务器状态趋势 <名称> [24h|7d|30d]`（默认 24h）。
- 规则插入位置：必须在 `^#?服务器状态\s+(\S{1,32})$` **之前**，避免被单机详情吞掉。
- 数据组装纯函数：

```js
export function buildTrendData(serverName, series, range, config)
// → {
//   summary: "CPU 均值 37.5% / 峰值 91.0% · 内存 52.1%",
//   charts: [
//     { key:"cpu", title:"CPU %", yMax:100, lines:[{label:"CPU", color:"#7aa2f7", path:"M0,120 L12,110 ...", last:"37.5%"}] },
//     { key:"mem", ... }, { key:"net", ... }
//   ],
//   xAxis: ["08:00","12:00",...],
//   empty: false
// }
export function scalePoints(points, { width, height, max, min = 0 }) // → SVG path 字符串
```

- 模板 `resources/server_trend.html`：纯内联 SVG（`<path>` + 网格线 + 图例），不引入图表库；点数超过 288 时按步长下采样。
- 渲染复用 `this.e.runtime.render(PLUGIN_NAME, "server_trend", data, { imgType, saveId })`；失败回退文本摘要。

#### 4.6.5 测试

- 聚合：均值/峰值正确；缺样本不生成桶；跨小时、跨天边界。
- 裁剪：超过上限按预期裁剪，文件大小受限。
- 损坏文件：启动不崩、备份生成。
- `scalePoints`：空序列、单点、全等值、NaN 防护。
- `buildTrendData`：范围切换、无历史数据（返回 `empty: true`）、服务器名转义。

#### 4.6.6 风险

| 风险 | 对策 |
| --- | --- |
| 写盘放大 | 复用 30s tick + 原子写；只在内容变化时写 |
| 文件膨胀 | 硬上限 + 裁剪 + 每台点数上限 |
| 渲染性能 | 下采样 ≤ 288 点；纯 SVG 无 JS |
| 时钟回拨 | 桶按本地时间对齐，落盘前排序去重 |

---

## 5. 兼容性矩阵

| 场景 | 结果 |
| --- | --- |
| 旧 agent（v0.1.21）→ 新插件 | 正常；`health`/`device`/`smart` 缺失，界面无过期标记、无健康徽标 |
| 新 agent → 旧插件（v0.1.21） | 正常；旧 `sanitizeSnapshot` 丢弃未知字段，其余行为不变 |
| 旧 config（无新键） | 正常；默认值：`stale_after=90`、`alert.rules=[]`、`history.enabled=true` |
| 关闭 `history.enabled` | 不写 `data/history.json`，`#服务器状态趋势` 回复「历史数据未启用」 |
| `alert.rules: []` | 仅离线/恢复告警，与 v0.1.21 一致 |
| `SM_SMART=0` 或无 smartctl | `disks[].smart` 为 `null`，其余不变 |

---

## 6. 实施计划

| 里程碑 | 内容 | 交付物 | 预估 |
| --- | --- | --- | --- |
| M1 | fixture 基建 + 4.1 GPU sysfs | `test/helpers/fs-fixture.mjs`、`test/agent-gpu-sysfs.test.js`、agent 改动 | 0.5 人日 |
| M2 | 4.2 健康度 + 4.4 SMART | 协议白名单、UI 过期标记、SMART 采集/解析/映射、测试 | 1.5 人日 |
| M3 | 4.5 阈值告警 + 静默时段 | `alert.js`（或 model.js 内模块）、config 解析、状态持久化、测试 + 文档 | 1.5 人日 |
| M4 | 4.6 历史与趋势 | `history.js`、聚合与裁剪、`server_trend.html`、新命令、测试 + 文档 | 2 人日 |
| M5 | 回归与发版 | 全量测试、三平台 dry-run、文档收尾、`chore: release 0.2.0` | 0.5 人日 |

合计约 6 人日。

实施顺序约束：

1. M1 先做（后续所有解析器复用 fixture 基建）。
2. M2 的协议白名单变更需同步文档；SMART 依赖 M1 的 fixture 模式。
3. M3 与 M4 相互独立，可并行；两者都依赖 M2 的 `decorateEntry` 输出。
4. 每个里程碑独立提交（Conventional Commits），可单独回滚。

---

## 7. 验收标准

### 7.1 功能验收

- [ ] Linux AMD 单卡：`--dry-run` 输出 `gpus[0].usage`、`memUsed/memTotal`、`temp`、`power` 非空。
- [ ] Linux Intel 集显：`usage`（若有）或至少 `power`/`temp` 非空。
- [ ] 无双卡错配：双卡机器的型号与占用率不串台（数量不一致时不绑定）。
- [ ] `health` 时间戳正确；慢采集失败时界面标灰且显示「数据 N 秒前」。
- [ ] SMART：有 smartmontools 时健康/温度/通电小时正确；无 smartctl 时全 `null` 且无报错。
- [ ] 告警：阈值 + `for` + 冷却 + 静默时段全部符合 4.5.2 状态机；多台合并一条消息。
- [ ] 趋势：`#服务器状态趋势 2c2g` 输出图片；`24h/7d/30d` 切换正确；无数据显示空态。
- [ ] `history.json` 超过 4MB 自动裁剪。

### 7.2 全局回归

- [ ] `node --check` 全部 JS/MJS；`bash -n` 全部安装脚本。
- [ ] `npm test` 全绿（现有 94 用例 + 新增用例）。
- [ ] 旧 agent 上报 → 新插件显示正常（无过期标记、无健康徽标）。
- [ ] 新 agent 上报 → 旧插件不报错（字段被忽略）。
- [ ] 4 台/5 台/离线/无 GPU/无磁盘渲染无回归。
- [ ] 三平台 agent dry-run：Linux、macOS、Windows（CI exe 冒烟）。

---

## 8. 风险与回滚

| 风险 | 影响 | 回滚 |
| --- | --- | --- |
| sysfs 路径差异 | 个别发行版 GPU 数据缺失 | 删除该采集器即可，其余字段不受影响 |
| smartctl 权限/卡死 | 采集变慢 | `SM_SMART=0` 关闭；单盘超时兜底 |
| 告警误报 | 打扰 | `alert.rules: []` 关闭；调大 `for`/`threshold` |
| 历史文件写坏 | 趋势不可用 | 自动备份 + 重建空文件；`history.enabled: false` 关闭 |
| 趋势图渲染失败 | 命令无图 | 回退文本摘要（复用 `buildTextFallback` 模式） |

发布策略：

- `v0.2.0` 为 minor 版本；功能均可关闭，默认行为与 `v0.1.21` 的差异仅在于「默认开启历史采集」（可通过配置关闭）。
- 发版流程沿用 `docs/项目交接文档.md` §13：四处版本号 + tag + GitHub 推送（tag 触发 exe 构建）。

---

## 9. 附录

### 9.1 beszel 源码对照

| 主题 | beszel 文件 |
| --- | --- |
| GPU 采集器优先级/回退 | `agent/gpu.go`（`startCollectorsByPriority`、`calculateGPUAverage`） |
| AMD sysfs | `agent/gpu_amd_linux.go` |
| Intel sysfs | `agent/gpu_intel_sysfs_linux.go` |
| NVIDIA NVML | `agent/gpu_nvml*.go` |
| SMART | `agent/smart.go`、`agent/smart_nonwindows.go`、`agent/smart_windows.go` |
| 告警状态与静默 | `internal/alerts/alerts.go` |
| 历史分层聚合 | `internal/records/records.go`（`CreateLongerRecords`、`AverageSystemStatsSlice`） |
| 采集器隔离/重连 | `agent/connection_manager.go` |
| 解析器 fixture | `agent/test-data/` |

### 9.2 现有代码锚点

| 位置 | 说明 |
| --- | --- |
| `agent/agent.mjs:184` `parseDfOutput` | 已纯函数化的解析器，可作为 fixture 化样板 |
| `agent/agent.mjs:133` `filterDisks` | 需透传 `fs` → `device` |
| `agent/agent.mjs:440` `collectGpuFallback` | AMD/Intel 接入点 |
| `agent/agent.mjs:750/783` `refreshFast`/`refreshSlow` | 健康度时间戳接入点 |
| `model.js` `sanitizeSnapshot` | 协议白名单扩展点 |
| `model.js:751` `decorateEntry` | 过期标记接入点 |
| `model.js:1298` `persist` | 历史采样与告警状态持久化复用点 |
| `index.js:62/71` 两个 task | 告警评估与历史落盘复用点 |
| `resources/server_status.html` | 过期标记与健康徽标 |
