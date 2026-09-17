# 周报采集与自动生成 — 产品契约与切片

Status: **accepted contract**（D1–D9 已锁定推荐项；schema 实现 CR 仍走 Frank 门禁）  
Date: 2026-09-17  
Branch: `feat/weekly-report-collection-alt`  
ADR: [ADR 0032（accepted）](../adr/0032-weekly-report-collectors-and-collect-run.md)

本文记录「从用户电脑采集工作信息 → 按老板模板总结 → 用户检查 → 发送」的产品契约、与设计稿/Multica 的对照、已锁定决策，以及实现切片。  
业务代码在后续切片中按 TDD 落地；引入 Collect Run 表的 Prisma migration 仍需 Frank 批准的 schema CR。

关联已落地能力：[`weekly-report-ai-requirements.md`](weekly-report-ai-requirements.md)（周报助手、确认写、用户发送）。  
设计对照入口：[`weekly-report-design-alignment.md`](weekly-report-design-alignment.md)；本能力主图为员工侧：

| 简称 | 文件 | 主题 |
| --- | --- | --- |
| **E1** | `front/员工 收到模板_1.png` | 收到模板 → 侧聊主动问是否生成 +「需要」 |
| **E2** | `front/员工 收到模板_2.png` | 「需要」后弹出采集计划卡（时间 / 电脑 / 路径 / 齿轮） |

参考实现（概念可复用，路径与宿主不可照搬）：Multica Period Work Brief / ADR 0019、`docs/notes-period-brief-assistant-contract.md`。

---

## 1. 产品目标

当成员收到 Leader 下发的周报模板，并决定让周报助手协助生成时，系统应：

1. 在用户拥有的电脑上，由本机 **采集 Agent** 收集时间窗内的工作证据；
2. 用户确认范围（哪些电脑、扫哪些路径、采集员用什么 runtime）；
3. 多机并行采集，平台感知完成/失败并能重试或放弃单机；
4. 按老板模板总结整理，确认后写入当前成员周报编辑器；
5. 用户检查后自行发送，或让助手打开既有发送确认（助手不得静默发送）。

---

## 2. 角色与职责（硬边界）

| 角色 | 做什么 | 不做什么 |
| --- | --- | --- |
| **用户** | 确认意图；配置缺失采集员；选时间/电脑/路径；改 Agent 配置；开始采集；决定重采或放弃；确认写入；发送 | — |
| **平台（Web/backend）** | ACL；探测采集员槽位；Ensure/创建采集员；计划卡权威状态；派发采集；settle；一次自动重试；唤醒合成；进度气泡 | 不把通用 job/workflow 做成核心模型 |
| **周报助手（WeeklyReportAssistant）** | 侧聊话术；读进度/pack 摘要；按模板产出 suggestion；提示检查与发送 | 不决定时间窗/电脑/路径；不调用 start；不扫 OS；不自动 send |
| **采集 Agent（WeeklyReportCollector）** | 在绑定 Computer 上按 recipes / collect-roots 扫盘；`submit-pack` / 上报失败 | 不写正式周报；不采别人的电脑 |

---

## 3. 端到端流程（对齐 a–e）

### 入口（E1）

1. 成员打开当周指派的周报（或点击新模板入口）→ 编辑器 + 侧聊展开。
2. 周报助手：「Hi，… 模板已收到，需要我直接帮你生成吗？」+「需要」按钮。
3. 用户点「需要」或说出等价意图 → 进入配置/计划链路（平台开卡，不是 XML fence）。

### a. 采集员感知与配置卡

1. 平台列出当前 User **拥有的**全部 Computer。
2. 对每台判断是否已有可用的周报采集 Agent（已绑定该 Computer、runtime/凭据可用）。
3. 若存在缺失：侧聊弹出 **采集员配置卡**（列出全部自有电脑，逐台配置）。
4. 配置动作复用现有 **Agent 创建/配置对话框**（Computer 已定、选 provider/model/凭据等）。
5. 用户可只配部分电脑；未配的可跳过，后续计划卡仅勾选已就绪机器。
6. 全部就绪或用户选择继续 → 进入计划卡。

### b. 采集计划卡（E2）

卡片字段：

| 区块 | 行为 |
| --- | --- |
| **采集时间** | 主下拉：周 / 月 / 季 / 年 / 自定义。次级：对应区间（如周 → `2026.08.31 - 2026.09.04`）；自定义打开日期选择。时间窗为半开区间，采集严格遵守。 |
| **采集电脑** | 列出已关联、用户拥有的电脑；多选。离线/无采集员的电脑标记不可用或引导去配置。 |
| **路径** | 每台电脑下展示扫描路径列表；铅笔编辑路径（写入本机 collect-roots；空则启发式 SCAN_ROOTS）。 |
| **齿轮** | 打开该采集 Agent 的配置对话框（换 Pi/Codex/Claude/CoForge、模型、凭据等）。 |
| **提交** | 对勾选且可用的电脑并行启动采集。零可用电脑时拒绝提交。 |

### c. 采集进行中

1. 每台：平台投递唤醒采集 Agent（ACK ≠ 完成）。
2. 采集员按 skill + recipes 扫盘，HTTPS `submit-pack` 上报采集包；失败则 HTTPS 上报错误摘要。
3. 单机进入终态（ready / failed / empty / stalled / cancelled）时，平台立刻在侧聊留一行（其它机可仍在跑）。
4. 可重试失败：平台 **自动再派一次**（每槽位最多 1 次）；永久配置/鉴权失败不重试，由用户改配置后重开计划。
5. 安全上限：**每波 15 分钟**；超时未终态标 `stalled`，再走重试/部分成功规则。
6. 周报助手可被进度 wake 说一句提醒；**不**由助手启动合成。

### d. 总结贴入

1. 全部槽位终态，或用户明确不再重采剩余失败机。
2. **至少一个 ready pack** → 平台唤醒周报助手合成：模板结构 + ready packs + 失败机状态板。
3. 无任何 usable pack → 不写空稿；侧聊说明并允许重开计划卡。
4. 合成结果以既有 `[weekly-report-suggestion]` 贴入当前周报位置；提醒用户检查。
5. 用户 Confirm 后写入正文。MVP：表格用 Markdown；图用 Mermaid。真图生成后置。

### e. 发送

1. 用户检查编辑器内容（可继续手改）。
2. 点发送，或对助手说「可以了 / 发送周报」→ 助手走 **send-prompt** / 打开既有发送确认。
3. 助手 **不得** 静默代发（与 AI requirements 一致）。

---

## 4. 状态机（平台权威）

### 会话/计划提示（可与 Run 分表）

| 状态 | 含义 |
| --- | --- |
| `awaiting_intent` | 已问「需要？」；等待确认 |
| `missing_collectors` | 展示配置卡 a |
| `clarifying` | 展示计划卡 b |
| `consumed` / `cancelled` | 计划已开始或用户取消 |

### Collect Run

| 状态 | 含义 |
| --- | --- |
| `collecting` | 并行采集中 |
| `synthesizing` | 周报助手合成中 |
| `awaiting_confirm` | suggestion 待用户确认写入 |
| `ready_to_send` | 已写入，提醒检查/发送（可与 awaiting_confirm 合并，实现时定） |
| `done` | 已发送或用户结束本次 |
| `cancelled` | 取消 |

### 单机槽位

`running` → `ready` | `failed` | `empty` | `stalled` | `cancelled`  
`empty`：进程正常结束但无 pack / 无窗内证据 → **不**自动重试，交给合成状态板。  
`failed` / `stalled`：可重试则平台最多再派 1 次。

**部分成功仍合成**（≥1 ready）。Composer 仅在 `collecting | synthesizing` 且确有进程在飞时可锁定输入（对齐 Multica）；主编辑器始终可读。

---

## 5. 数据与传输约束（待 ADR 接受后落库）

- **WeeklyReportCollectRun** + collectors JSON/子表：挂当前成员 `WeeklyReport`、发起 User、时间窗、各槽位 pack/错误/重试。
- **采集员身份**：每 User 拥有的 Computer 至多一个周报采集 Agent；稳定命名；不进 Members 独立管理（默认对齐周报助手隐藏策略，D9）。
- **collect-roots**：Computer 本地权威；云端可缓存展示。
- **上报**：Agent HTTPS（扩展 `/api/agent/v1/...` 族），稳定 `request_id`；**不用** Agent Activity 做完成边界；**不**新增 WSS 业务 RPC 传 pack。
- **非**通用 Workspace job / claim-lease / 本地 durable inbox。

---

## 6. 与现有能力的边界

| 已有 | 本能力 |
| --- | --- |
| 周报助手 Computer/Runtime 未配置提示 | **并存**：助手自身要能聊/合成；采集员是另一套每机 Agent |
| `coforge weekly-report context\|list\|read` | 合成仍可用；另增 collect submit-pack / failure |
| suggestion Confirm 写 body | 合成输出继续走该信封 |
| Leader 发送 / cron / `#general` | 不变 |
| Action Card（ADR 0027） | 计划/配置卡可复用「人确认」精神；种类可以是 Records 专用卡，不必塞进 `channel:create` 族 |

---

## 7. 决策表（D1–D9）— 已锁定

2026-09-17 按实现切片推荐项全部锁定为 ★ 选项（D1A–D9A）。细节见 [ADR 0032](../adr/0032-weekly-report-collectors-and-collect-run.md)。

| ID | 议题 | 锁定 |
| --- | --- | --- |
| **D1** | 采集员身份 | **A** 每 Computer 一个专用采集 Agent |
| **D2** | 配置/计划卡宿主 | **A** 侧聊内嵌平台卡（对齐 E2） |
| **D3** | 谁启动采集 | **A** 人点「提交」，平台编排 |
| **D4** | 扫盘路径权威 | **A** Computer 本地文件 + 授权读写（云端可缓存展示） |
| **D5** | 采集结果账本 | **A** PG 窄域 Collect Run（非通用 job） |
| **D6** | pack / 失败上报 | **A** Agent HTTPS |
| **D7** | 失败策略 | **A** 每槽位最多 1 次自动重试 + 部分成功仍合成 + 可放弃单机 |
| **D8** | 图/表 MVP | **A** Markdown 表 + Mermaid（真图后置） |
| **D9** | 采集员与 Members | **A** 与周报助手一样不进 Members 独立管理 |

**架构说明：** D5 批准的是「周报采集专用 Run」，明确 **不是** 引入通用 workflow/mailbox。`docs/architecture.md` 已记录该例外。落地表结构的 migration 仍走 Frank schema 门禁。

---

## 8. 术语（已写入 `CONTEXT.md`）

| 术语 | 含义 |
| --- | --- |
| **WeeklyReportCollector** | 绑定用户自有一台 Computer 的周报采集 Agent；只产采集包 |
| **WeeklyReportCollectRun** | 一次「计划确认 → 并行采集 → 合成」的平台账本 |
| **Collect pack（采集包）** | 单机上报的结构化 Markdown 证据包（非终稿周报） |
| **Collect plan card（采集计划卡）** | E2 侧聊卡：时间窗 + 电脑 + 路径 |
| **Collector setup card（采集员配置卡）** | 缺采集员时的配置卡 |
| **Collect roots** | 本机扫描根路径列表；空则启发式 SCAN_ROOTS |

_Avoid:_ 把 Collect Run 叫成 Task/Job/Workflow；把采集包叫成周报正文；把周报助手叫成采集员。

---

## 9. 实现切片（批准决策后）

| # | 切片 | 完成定义 |
| --- | --- | --- |
| 0 | 本文 + ADR 0032 + 锁定 D1–D9 + architecture/CONTEXT | ✅ |
| 1 | Collect Run schema CR（Frank 门禁）+ 领域测试缝 | ✅ 干净重写：binding + run + slot；见 `weekly-report-collect-port.md`（不整包搬 WIP） |
| 2 | 采集员槽位探测 + Ensure/创建 API | ✅ `listOwnedComputerSlots` / `ensureCollector`（Server Fn / UI 后置） |
| 3 | collect-roots 本机文件 + 读写缝 | 空=启发式；非空替换 |
| 4 | Daemon skill + submit-pack / failure HTTPS | 单机采集可测 |
| 5 | UI：E1「需要」+ 配置卡 a | 手动验收侧聊 |
| 6 | UI：计划卡 b（时间/电脑/路径/齿轮） | 对齐 E2 |
| 7 | 并行编排 + settle + 重试 + 进度话术 | 双机一成一败用例 |
| 8 | 合成 wake → suggestion → Confirm 贴入 | 接现有写路径 |
| 9 | 「可以了发送」→ send-prompt | 不自动 send |
| 10 | 打磨：空 pack、离线机、取消、15min stalled | 回归 + 手动 UI |
| 11 | （后置）真图 / 复杂表展示 | 另开 CR |

每切片：TDD、短 CR、rebase `main`、`mise run test|check|build`。

---

## 10. 测试要点（行为，非 UI 单测）

- 只能采自己的 Computer；同事机器永不出现在计划卡。
- 缺采集员不静默建齐；Submit 零可用电脑失败。
- 并行：一机失败即时可见；自动重试至多一次；≥1 ready 仍合成。
- 全失败不写空稿。
- ACK ≠ collect 完成；无 pack 的「成功退出」= empty。
- suggestion 未经 Confirm 不落库正文。
- 助手消息/工具不能直接 mark report submitted / send。
- 凭据、环境变量、路径外隐私目录不得进 pack / 日志。

UI：按 `docs/agents/testing.md` 手动验桌面/移动、主题、卡状态、Escape/滚动。

---

## 11. 风险

- Schema 与「窄域 Run」若被理解成通用任务引擎，会冲撞 architecture — ADR 必须写清边界。
- 采集依赖本机 Daemon/runtime 在线；计划卡需诚实展示离线。
- Multica recipes 移植时去掉 `.multica` / Notes Worker 假设，对齐 CoForge computer 数据目录与 code-agent adapter。
- 周报助手自身未配置 vs 采集员未配置：两套状态文案，避免互相覆盖。

---

## 12. `#coforge` 通知短讯（决策已锁定）

```text
周报采集自动生成 — D1–D9 已按推荐锁定（D1A–D9A），ADR 0032 accepted：

- ADR: docs/adr/0032-weekly-report-collectors-and-collect-run.md
- 契约: docs/implementation-slices/weekly-report-collect-requirements.md
- architecture.md / CONTEXT.md 已同步

下一刀：Collect Run schema CR（仍走 Frank migration 门禁），然后切片 2 起实现。
```

---

## 13. 开放问题（实现时再定）

- Prompt 表与 Run 表是一张还是两张（Multica 拆 `prompt` + `run`）。
- 采集包过大时是否改 OSS object key（走既有 FileStorage）而非 JSONB。
- 合成是否注入 Workspace「平台事实」（CoForge 若无 Issues/PR 同源，MVP 可仅 packs + 模板）。
- 页级 subject 与 Collect Run 的绑定：仅当前打开的 member report，还是允许切换目标稿。
