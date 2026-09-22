# Windows GPU 占用率修复说明

## 1. 本次改动

- 修正了 Windows 侧 GPU 兜底采集逻辑。
- 之前 `nvidia-smi` 不可用时，系统只取显卡型号和显存，**不取占用率**。
- 现在 `nvidia-smi` 失败时，会继续从 `systeminformation` 里读取：
  - GPU 占用率
  - GPU 温度
  - 显存占用 / 总显存
  - GPU 功耗
- agent 版本号从 `0.1.16` 升到 `0.1.17`。
- 已提交并推送，commit：`de3d164`

## 2. 改动原因

用户反馈 Windows 机器已经绑定成功，但状态卡里没有 GPU 占用率。

排查后发现原因：

- Windows 侧 GPU 主要来源是 `nvidia-smi`。
- 如果 `nvidia-smi` 不在 PATH 或不可用，agent 会退到 `systeminformation`。
- 旧的兜底代码只拿了 `model` 和 `vram`，没有拿 `utilizationGpu`。
- 所以 Windows 上即使有 GPU 数据，也只显示型号，不显示占用率。

## 3. 改动思路

把 GPU 采集分成两层：

1. 优先走 `nvidia-smi`
   - 精度高，能拿占用率、温度、显存、功耗。
2. 失败时退到 `systeminformation`
   - 兼容更多 Windows 环境。
   - 现在不只拿型号，也把占用率等字段映射回来。

## 4. 设计

新增的兜底映射逻辑：

- `model`：优先 `ctrl.model`，否则 `ctrl.name`
- `usage`：优先 `ctrl.utilizationGpu`，否则 `ctrl.utilization`
- `temp`：优先 `ctrl.temperatureGpu`，否则 `ctrl.temperature`
- `memUsed`：优先 `ctrl.memoryUsed`，其次 `ctrl.vramUsed` / `ctrl.vramMemoryUsed`
- `memTotal`：优先 `ctrl.vram` / `ctrl.vramTotal` / `ctrl.memoryTotal`
- `power`：优先 `ctrl.powerDraw`，否则 `ctrl.power`

这样可以让 `systeminformation` 里已经存在的 GPU 信息被完整利用起来，而不是被丢掉。

## 5. 想法

这个问题的本质不是“Windows 没有 GPU 数据”，而是：

- `nvidia-smi` 只对 NVIDIA 卡可靠。
- 其他品牌（AMD / Intel）通常没有统一、稳定的占用率接口。
- 所以需要一层兜底，把能拿到的尽量拿回来。
- 拿不到的字段继续留空，不伪造数据。

## 6. 使用方式

更新 Windows agent 后重启即可。

如果重启后还是没有 GPU 占用率，可能是：

- 这台机器是 AMD / Intel 集显
- Windows 没有暴露通用 GPU 占用率
- `systeminformation` 也没有拿到 `utilizationGpu`

这种情况下可以进一步做 Windows 专用扩展，比如接 `Get-Counter` 或厂商 SDK，但目前先保持通用、稳定，不引入额外依赖。

## 7. 相关文件

- `agent/agent.mjs`
- `agent/package.json`
- `agent/package-lock.json`
- `package.json`
