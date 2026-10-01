# dsh-sensenova-freeapi

> SenseNova（OpenAI 兼容）API 的 DeepSeek Harness 无痛 LLM provider 插件 —— 用「运行态 / 阻塞态双列表」状态机 + 「双账户轮换」思想，把渠道限流从「错误轰炸」变成「稳定服务」。

![release](https://img.shields.io/badge/status-alpha_0.1.0-ff9a00)
![license](https://img.shields.io/badge/license-MIT-blue)

## 核心思想：把「限流」当作常态来设计

SenseNova 渠道对单 key 存在 **TPM / RPM 并发与配额限制**，瞬时超限会抛 `429`。大多数插件的做法是「报错 + 重试」，于是连续限流时会陷入**正反馈死锁**：计数只在 2xx 清零 → 短路导致零成功 → 计数永不清零 → 短路永不解除 → 只能重启进程。

本插件换了一个思路：**限流不是事故，是运行常态**。于是用两个显式列表来管理每一把 API key 的状态：

### 运行态 / 阻塞态 双列表状态机

```
运行态（running）                      阻塞态（blocked）
  key 可被 agent 请求选中                key 等待恢复，不再被任何 agent 请求选中
      │                                     │
      │ 连续 kickThreshold 次 tpm 限流       │ 外部调度器定期用「最小请求」探测
      ▼                                     ▼
  移出运行态 ──────────────→ 进阻塞态     探测成功 → 挂回运行态末尾
                                        探测失败 → 退避更久（15s → 30s → 60s）
```

三条不可让步的性质（也是与旧「全池短路」机制的本质区别）：

1. **保底**：运行态只剩 1 把 key 时永不踢出 ⇒ 池永远不会空，agent 请求永远发得出去。
2. **借用**：运行态候选被排除排空时，从阻塞态借「阻塞最久」的一把临时使用（**不改变其相位**）。
3. **恢复与请求解耦**：阻塞态 key 的相位**只由探测结果决定**，不经过 agent 请求路径 ⇒ 不受「零成功」污染，随时能把 key 救回运行态。**这是根治旧死锁的关键。**

> 为什么必须探测恢复：agent 请求只会选中运行态的 key，阻塞态的 key 不会被任何请求打到。如果没有人主动去试探它，它就永远回不来 —— 调度器每隔 `probeInitialMs`（默认 15s，请求数桶的恢复周期就是这个量级）用一次最小请求探一下，成功即复活。

### 双账户轮换：交替使用，大幅降低报错与限流

- 支持 **1 个默认账户 + 多个额外账户**（`accounts[]`，各配独立 `apiKeyEnv` 凭据引用），同一份共享 base URL。
- 请求在多个 key 之间**轮换交替**：被 `exclude`（401 或配额轮换）的 key 会从**它的下一个位置环回**选取，避免旧实现的「前两把乒乓、第 3 把永远轮不到」问题。
- **配额类 429 会粘性换 key**：被拒的 key 保持可用状态，下次从下一把继续，把单 key 的瞬时限流摊到多把 key 上。
- 401（无效凭据）才永久禁用该 key，直到凭据被修改；429 一律不冷却、不禁用（渠道常态性限流不代表账号异常）。

**实测效果**：多把 key 轮换后，429 不再集中轰炸单 key，请求分布在多个账户上，单账户触顶概率大幅下降。

---

## 为什么能「长时间稳定运行」——长程实测支撑

本项目所有关键参数都不是拍脑袋，而是**在长程运行中实测校准**的：

| 实测项 | 结论 | 依据 |
|---|---|---|
| Retry-After 上限 | 提到 `60_000ms`（原 3000ms 与 TPM 60s 窗口量级不符） | 2026-09-04 长程实测 |
| 排队超时 | 默认 60s，与 TPM 窗口对齐，排队必须有界 | design D4/D6 实测 |
| 双列表状态机 | 取代「全池饱和短路」正反馈死锁（计数只在 2xx 清零 → 短路 → 零成功 → 死锁） | 2026-09-27 重构 |
| 环回轮换修复 | 排除项后必须从下一位置环回，否则第 3 把 key 永远轮不到 | 9265 条 429 日志统计：旧实现只有 2 个账号指纹（各约一半），第 3 把一次都没出现 |
| 探测间隔 | 15s 起、×2 退避、60s 封顶（请求数桶恢复周期量级） | 2026-09-27 实测 |

> 📌 **连续使用 5 小时长时间稳定运行**：在上述机制（双列表 + 双账户轮换 + 探测恢复）下，插件在长程会话中持续稳定工作，限流被有序处理而不是报错轰炸，不再需要重启进程来解死锁。

---

## 功能一览

### 🧠 双列表 key 池（运行 / 阻塞）
- 池级单例、跨会话共享：key 的配额是全局属性，不该被会话隔离。
- 连续限流踢出、保底不空、借用最久阻塞、探测恢复、15/30/60s 退避，全部可配置。
- 每把 key 状态（相位、strikes、blockedSince、probeAttempts）在设置页只读展示。

### 🔄 双账户轮换
- 默认账户 + 多额外账户，同 base URL。
- 环回轮换 + 配额类 429 粘性换 key + 401 永久禁用。
- 被禁用 key 凭据修改后自动恢复。

### 📋 错误记录表（只读诊断区块）
- 每次限流落成一条结构化事件，异步写入、**绝不阻塞、绝不抛出**（写日志失败只静默吞掉）。
- 字段：`time / model / error.code / account fingerprint / retryFloorMs / probeHits / poolRunning / poolBlocked / rotated / attempt`。
- 密钥只存内存、日志只写 **sha256 指纹**，key 原文永不落盘、永不出境。
- 设置页「诊断」区块只读展示最近拉取结果，不参与配置流程、不影响运行。

### 📊 「当前模型 + 全部参数」面板（只读可视化）
- 回答三个问题：**我现在用的是哪个模型？它到底支持什么？哪些参数我能改？**
- 数据来自宿主实际解析结果 + 131 项实测（2026-09-23 Phase 5 实测校准）。
- 只读、不影响运行；旧 host / 数据不完整时只显示「信息不全」而不崩。

---

## 安装

```bash
# 本地路径装入（推荐用于接入 DSH 验证）
dsh plugin --profile <name> add /path/to/dsh-sensenova-freeapi

# GitHub 发布后
dsh plugin --profile <name> add github:你的用户名/dsh-sensenova-freeapi

# 或 npm 发布后
dsh plugin --profile <name> add dsh-sensenova-freeapi
```

然后在「模型」页配置 SenseNova：
- 默认凭据环境变量：`SENSENOVA_API_KEY`
- 默认 base URL：`https://token.sensenova.cn/v1`

## 配置项

| 字段 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `apiBase` | string | `https://token.sensenova.cn/v1` | 所有账户共享的 base URL |
| `apiKeyEnv` | credential-ref | `SENSENOVA_API_KEY` | 默认账户凭据引用 |
| `accounts[]` | array | `[]` | 额外账户：`{ id, label, apiKeyEnv }` |
| `activeAccount` | string | `""` | 首选账户 id；空 = 自动 / 首个可用 |
| `quotaRotation` | bool | false | 配额类 429 是否粘性换 key |
| `concurrency` | int | 1 | 每 key 并发闸上限（达限排队 FIFO） |
| `queueTimeoutMs` | int | 60000 | 排队等待上限 |
| `poolPolicy.kickThreshold` | int | 2 | 连续多少次 tpm 限流踢出运行态 |
| `poolPolicy.probeInitialMs` | int | 15000 | 首次探测间隔 |
| `poolPolicy.probeBackoffFactor` | int | 2 | 探测失败退避倍率 |
| `poolPolicy.probeMaxMs` | int | 60000 | 探测间隔上限 |
| `poolPolicy.capacity` | int | 10 | 池容量上限 |
| `errorLog` | bool | true | 是否记录限流事件到错误日志 |

> API keys 一律经 DSH 凭据服务存储，**永不写入日志、永不发送给模型**。

## 开发

```bash
pnpm install
pnpm run typecheck
pnpm run build    # tsdown → lib/
pnpm test         # node --import tsx --test tests/**/*.test.ts
```

## 许可证

MIT
