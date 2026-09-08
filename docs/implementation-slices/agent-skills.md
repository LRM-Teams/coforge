# Agent Skills 与 Session 作用域：调查与实现切片

调查日期：2026-09-08。本文保留调查证据、实现记录与剩余方案；架构契约仍以
[architecture.md](../architecture.md) 与 [ADR 0002](../adr/0002-provider-native-code-agent-subprocesses.md) 为准。
用户已确认 Skills 按需查询方向，以及 Session 始终按 Agent workspace 隔离（含外部 Pi）；
不需要 Session 列表、正文展示或 transcript 上报。用户后续已确认：Agent owner 可以查看该
Agent 所用 runtime 的 Global／Workspace Skills 元数据，不要求同时是 Computer owner。
这不授予读取正文、修改文件或浏览其他 Agent 目录的权限。用户随后要求继续对齐并在
Profile 显示两组 Skills，先按选项 A 完成按需查询切片，随后批准 Session identity
持久化与三种控制操作并继续实现（第 10 节）。不增加 Skills assignment/writer 或任意外链扫描。

**最新决定覆盖早期隔离提案**：用户随后确认 Claude Code/Codex 对齐 Raft 的宿主原生
存储实现，保留全局配置；二者不再要求 Session 文件物理位于 Agent workspace。内置/外部
Pi 的 workspace Session 目录不变。决定记录于 ADR 0002 的 2026-09-08 补充及 architecture.md；
本文第 7 节保留调查时的候选方案作为证据，不将已放弃的隔离 config home 继续列为阻塞。

## 1. Raft 的可核实证据

公开可取得的是官方发布的
[`@botiverse/raft-daemon@1.0.17`](https://registry.npmjs.org/@botiverse/raft-daemon/1.0.17)
及其 [tarball](https://registry.npmjs.org/@botiverse/raft-daemon/-/raft-daemon-1.0.17.tgz)，
不是 1.0.18；该版本的官方 package 本次不可取得：1.0.18 的
[registry metadata](https://registry.npmjs.org/@botiverse/raft-daemon/1.0.18)
与 [tarball](https://registry.npmjs.org/@botiverse/raft-daemon/-/raft-daemon-1.0.18.tgz)
本次均返回 HTTP 404。包声明的源码仓库为 `github.com/botiverse/slock`，公开 GitHub API
也返回 404；不能据此断言仓库不存在，但当前公开渠道不能获得其源码。

1.0.17 包内 `dist/chunk-NIGZD5D2.js` 的 SHA-256 为
`17df450a15bb4a07a29a9f0af115bf00a5d67b828843d3c76ce07d27825d93d0`。
直接阅读该发布产物得到：

| 位置 | 已验证行为 |
| --- | --- |
| `SKILL_PATHS`，约 29049 行 | Claude global/workspace 均配置 `.claude/skills`、`.claude/commands`；Codex workspace 配置 `.codex/skills`、`.agents/skills`。Pi 无专属条目，落到 Claude fallback，不应复制此行为。 |
| `listSkills`，约 29186 行 | 取运行中或 idle Agent config，workspace 为 `dataDir/agentId`；runtime home 来自当前 runtime 或其 home resolution。按请求读文件系统，不是读取已运行 Session 的 loaded skills。 |
| Codex 特殊分支，约 29195 行 | 实际 global 扫描 `<codexHome>/skills`、`skills/.system`、`.agents/skills`；未显式配置 Codex home 时还包含宿主 `~/.agents/skills`。不能只读静态路径表就推断实际扫描位置。 |
| `dedup`，约 29210 行 | 每个 scope 内按 `name` 去重，先搜索到的目录胜出；Global 与 Workspace 不互相去重。HOME 前缀被缩为 `~`。 |
| `scanSkillsDir` / `parseSkillMd`，约 29225 行 | 扫描一层子目录（含 symlink）的 `SKILL.md` 和根目录 `.md`；逐行解析简单 frontmatter，返回 `name`、`displayName`、`description`、`userInvocable`、`sourcePath`。没有返回正文。默认 `userInvocable=false`，并不等于 Claude 原生默认值。 |
| `case "agent:skills:list"`，约 41561 行 | 收到请求调用 `agentManager.listSkills(agentId, runtime)`；通过 daemon connection 发送 **`agent:skills:list_result`**，包含 `agentId`、`requestId`、`global`、`workspace`。失败也发送两个空列表。 |

因此“Raft 不上报 Skills”是错误结论。已核实的是请求驱动的目录元数据响应；不是 runtime
inventory 推送，也不是完整的 provider 加载成功证据。UI 是否恰好在 Profile mount 时发送、
云端如何鉴权/持久化、1.0.18 是否修改该实现，均未从公开源码核实。
Raft 的 transcript 接口是另一项功能，不属于本次对齐目标。

## 2. Provider 原生目录与时机

下表中 `A` 是 CoForge 分配的稳定 Agent workspace，`H` 是 provider 实际使用的用户 HOME，
不是通过改 HOME 隔离 Session 得到的临时目录。`<skill>` 下均使用 `SKILL.md`。

| Provider | Global 原生来源（保持用户所有） | Workspace 推荐写入点 | 其他原生发现/优先级 |
| --- | --- | --- | --- |
| Claude Code | `H/.claude/skills`；legacy `H/.claude/commands`；managed/plugin 来源由 CLI 处理 | `A/.claude/skills/<skill>/SKILL.md` | `A/.claude/commands` 仍有效；原生还发现到 repo root 的祖先、按访问加载嵌套目录。enterprise > personal > project，同级 skill 优先于 legacy command；插件使用命名空间。 |
| Codex | 当前官方文档列 `H/.agents/skills`、`/etc/codex/skills`、bundled system；历史/版本相关 `$CODEX_HOME/skills` 由实际 CLI 确认 | `A/.agents/skills/<skill>/SKILL.md` | `.agents/skills` 从 cwd 到 repo root；同名可并存，不套用统一覆盖规则。Raft 兼容目录 `.codex/skills` 不是当前官方推荐写入点。 |
| 外部 Pi | `H/.pi/agent/skills`、`H/.agents/skills`；package/settings/显式 CLI additions 由 Pi 处理 | `A/.pi/skills/<skill>/SKILL.md` | 可信项目的 `.agents/skills`（cwd 及祖先）；递归发现；同名 first-found 并给 diagnostic。原生 `.pi/skills` 还可发现带有效 frontmatter 的根 `.md`。 |
| 内置 CoForge | 保持现有独立 `A/.builtin-runtime` 配置，不接管用户外部 Pi 身份；是否额外读取用户 shared global Skills 需单独决定 | `A/.pi/skills/<skill>/SKILL.md` | 使用 pinned Pi SDK ResourceLoader，不根据 Raft 的 Pi fallback 实现。不要把独立 auth/config 目录误解为已完全隔离 SDK 的所有祖先/shared skill discovery。 |

一手来源：[Claude Skills](https://code.claude.com/docs/en/skills)、
[Codex Skills](https://developers.openai.com/codex/skills/)、
[Pi Skills](https://pi.dev/docs/latest/skills)。这些是滚动文档，不意味着所有用户 CLI 版本都有最新行为。

发现与 reload 必须区分：

- Claude 原生对已有 Skills 目录监听改动；启动时不存在的顶层目录可能需要重启。
  CoForge 的 stream control `initialize` 必须返回合法 `commands` 才 ready；空列表有效。
  [SDK 声明](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.247/sdk.d.ts)
  的 `SDKControlInitializeResponse.commands` 是 `SlashCommand[]`，必需字段为 `name`、
  `description`、`argumentHint`。该列表混合 commands/skills；隐藏的 model-invocable skills
  可不出现，不能证明全部 Skills 已加载。参考
  [SDK command discovery](https://code.claude.com/docs/en/agent-sdk/slash-commands#discover-available-commands)。
- Codex 原生自动检测 Skills 改动，配置变化可能需要重启；CoForge 每次新建 Agent Session 前
  执行 `skills/list(cwds: [A], forceReload: true)`，拒绝缺失 cwd 或 skill loading errors，
  然后 `thread/start`。参考 [app-server](https://developers.openai.com/codex/app-server)。
- Pi 在启动时发现；SDK 创建服务时完成 ResourceLoader 初始化。CoForge 已将 skill
  diagnostics 视为启动失败。外部 Pi 的 `get_commands` 仅是握手读取，不等于强制 reload。
- Profile 刷新只重读目录元数据，不重启 Agent、不调用 reload、不修改正在执行的 Session。
  “目录存在”“provider 已发现”“正文被模型读取”是三个不同事实。

## 3. CoForge 调查起点的代码边界与缺口（后续实现见第 8 节）

| 所有者/文件 | 当前事实 |
| --- | --- |
| `packages/daemon/src/agent-runtime/agent-workspace-path.ts` | 从不可变 Workspace/Agent ID 构造 `workspaces/<workspace_id>/agents/<agent_id>`；不能接受浏览器传 cwd。 |
| `agent-runtime/agent-process-manager.ts`、`code-agent/contract.ts`、`packages/agent` | `AgentSessionOptions` / `AgentDriver.createAgentSession` 是现有 provider-neutral 启动 seam；standing instructions 通过 provider native injection，不靠写用户 AGENTS/CLAUDE 文件。 |
| `code-agent/{claude-code,codex,pi}/driver.ts` | 各自拥有原生启动/discovery；Claude 此前只判断 init success，未校验 commands，本切片修复；Codex 已强制 reload；Pi 已发 `get_state/get_commands`。 |
| Skills writer | ADR 已批准 CoForge 分配的 Skills 写入 Agent 的原生 project scope，但当前没有完整的分配来源、writer 或云端 assignment 协议。不能把架构意图说成已经实现。未产生 CoForge 分配项时，无需复制 Global Skills 来凑出 writer。 |
| `code-agent/environment.ts` | 默认继承 HOME/PATH/XDG 等基础变量；`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`PI_CODING_AGENT_DIR` 不是默认透传项，只有显式声明才传递。查询必须使用与该 Agent 启动相同的有效环境，不能盲扫 daemon 原始 env。 |
| `code-agent/runtime-inventory.ts`、`daemon-runtime/runtime.ts` | 启动/重连扫描、上报 runtime 与 models。实际 `discoverCodeAgentInventory` 包含内置 CoForge metadata，也可发现外部 Pi；与文档部分“只报外部 Codex/Claude”的措辞存在偏差，本任务不顺带修改库存行为。 |
| `packages/protocol/proto/coforge/rpc/v1/daemon_runtime.proto`、`index.ts`、`codec.ts` | inventory 只有 runtimes/catalogs，没有 Agent Skills 查询/结果 schema。使用现有 usage 的 `snapshot_json` 偷渡 skills 仍然是 wire 语义变更。实际 method 常量为 `daemon:code_agents_update`。 |
| `apps/web/src/server/centrifugo/rpc-handler.server.ts` | `createDaemonRuntimeCodeAgentsUpdateMethod` 校验 trusted Workspace/Computer claims、协议及 payload，然后调用 inventory repository。 |
| `server/db/repositories/computer-runtime.repositories.server.ts` | 事务替换 `computerRuntime`/`computerModelCatalog` 快照，保留已有 runtime 可见性；不是 per-Agent Skills snapshot 所有者。 |
| `features/agents/agents.functions.ts`、`agent-detail.tsx` | 现有 Profile 查询没有 Skills；普通 Agent 详情可见权限不能自动授权读取 Computer HOME 元数据。 |

Daemon 可以在已批准的 assignment 输入可用后写 **CoForge 自己分配**的 workspace skills，
必须在 native discovery 前完成；不能覆盖用户已有同名文件、绕 symlink 写到其他 Agent，
也不能把 global skills 复制进 workspace。Global 始终由用户/provider 管理；将来查询只是
经过授权的只读元数据枚举，不获得写 HOME 或执行 skill 的权限。

## 4. 云端查询切片（本轮采用选项 A）

### 选项与建议

| 选项 | 收益 | 代价/风险 | 建议 |
| --- | --- | --- | --- |
| A：专用 versioned WSS 按需 Skills request/result | 对齐 Raft 的查询行为；不启动 provider；不改变库存/数据库 schema；Agent 离线但 daemon 在线仍可查询 | 新 wire 与具体扫描边界需批准；Agent owner 的两组元数据可见范围已确认；目录列表不是 loaded list | 推荐 |
| B：扩充 Computer inventory / PostgreSQL 快照 | Profile 读取快 | 每次 startup/reconnect 扫描所有 Agent；失去按需性；增加 schema/隐私/过期与替换语义 | 不推荐 |
| C：每次 Profile 打开启动 CLI/SDK 查询实际 skills | 可以获得部分 native catalog | Claude/Pi/Codex 返回能力不等价；可能触发插件、配置、登录或进程副作用；不能保证统一 loaded 语义 | 不作为默认；未来单独提供诊断 |

A 复用已有 Bun、protobuf、Centrifugo 与 Redis，不新增框架或 runtime 版本；这些都是现有
维护依赖，不引入 Raft 发布代码或其未明确的 license。运行成本是一次有界磁盘读取、一次
WSS request/result 与短 TTL 临时关联记录。不会发布新包或改许可证。

已实现 schema（`packages/protocol/proto/coforge/rpc/v1/agent_skills.proto`）：

```text
agent:skills:list -> AgentSkillsListRequest
  protocol_major, message_type, request_id,
  workspace_id, computer_id, agent_id, provider

agent:skills:list_result -> AgentSkillsListResult
  同一完整关联 scope；scanned_at_ms
  global / workspace:
    status = ok | unsupported | error | partial
    entries[] = { name, description, source_path }
    directories[] = { path, status = scanned | missing | unreadable | unsupported }
```

`source_path` 是来源标签下的相对路径（如 `~/.claude/skills/review` 或
`.agents/skills/review`），不上传用户绝对路径或正文。不要把 `user_invocable` 强制统一为
boolean：Raft 默认 false 与 Claude 默认 true 已矛盾；首版省略，未来如需要则使用
`unknown/yes/no` 并标明 provider 依据。`loaded=true`、session ID、transcript 均不在此协议。
目录缺失是正常空来源；读失败、文件过大/非法 frontmatter 是 diagnostic，不冒充空列表。
实现预算：最多 256 KiB/文件、每 scope 256 项、2,048 个访问节点、深度 8、总 wire
1 MiB、协作式 3 秒检查；截断使用 partial，不另加 truncated 字段。单个 filesystem I/O
可能超过检查预算，它不是强制终止 I/O 的保证。Daemon 一次执行一个扫描，繁忙返回 error。

建议调用与错误边界：

1. Profile Skills 面板挂载/刷新调用 authenticated Server Function（POST），只传 Agent ID。
   Backend 从当前 Workspace 的 canonical Agent 查询 Computer/provider，再校验权限。
   **已确认：Agent owner 可看该 Agent 所用 runtime 的 Global 与 Workspace 两组元数据，
   无需同时是 Computer owner。** Runtime 公开不意味着所有成员可以任意浏览 HOME；
   查询必须绑定请求者拥有的 Agent 及其当前 assignment，不包含正文读取或文件修改权限。
2. Backend 先创建包含完整 scope 与请求者的 Redis pending record（TTL 建议 30 秒），
   然后 publish 到已有 `daemon:<computer_id>`；不要复用 usage 按 provider 的 cache key。
3. Daemon 校验协议和 configured Workspace/Computer；从稳定 ID 计算 A，使用与 Agent
   runtime 一致的 effective env。不得接受请求端自定义路径、glob、HOME 或 runtime fallback。
4. `code-agent/` 拥有 provider-native metadata 发现适配，归一化输出；`daemon-runtime/`
   只调度并回传。首次上线先明确支持范围，未知 provider 返回 unsupported，不能像 Raft
   一样静默 fallback 到 Claude。首版仅枚举已声明 global/workspace roots；插件、managed、
   settings additions、祖先/嵌套未覆盖时明确显示覆盖限制，不称“全部已加载 Skills”。
5. 支持 provider 原生 symlink 不等于允许云端扫描任意目标：建议只返回已声明根内的解析结果，
   越界项记 unsupported，不跟随至其他 Agent；不修改 provider 自身的本地加载行为。
   如果需要跟随用户任意外链，必须另行批准读取边界。
6. Result handler 校验 Centrifugo trusted claims、pending record、完整 scope、大小与字段；
   未请求/过期/不匹配结果丢弃，重复结果幂等。返回浏览器前再次检查 membership、ownership
   与当前 assignment/config，防止等待期间移机、换 provider 或撤权的数据泄露。
7. Backend bounded wait（建议最多 5 秒）后返回结果或 timeout；Computer 已知离线返回 offline，
   但 online lease 不保证请求一定送达。关闭 Profile 或旧响应不得覆盖新 Agent/刷新结果。
   不持续轮询 Computer inventory；不在 PostgreSQL 存 Skills，不在 Activity 中塞结果。

### 模块落点与验收顺序

owning `AGENTS.md` 已记录模块职责，验收使用下列公开 seam：

1. `code-agent/` metadata query：Global/Workspace 原生目录、有效环境、符号链接、重复名、
   frontmatter、部分失败、限额、第二次查询看到文件改动；证明没有写 HOME。
2. protocol schemas / codecs：新增 messages 与 discriminators；roundtrip、unknown/malformed、
   scope、长度限制；旧 daemon 不处理新消息时 UI 超时/不支持，而不是空列表成功。
3. daemon connection + runtime：query/result 路由；仅本 Workspace/Computer；不创建 Agent
   Session、不 reload、不上报 inventory；错误不影响正常消息和 Agent 生命周期。
4. Web `server/agents/` query + `server/centrifugo/` result：真实权限矩阵、assignment 改变、
   cross-scope injection、重复/晚到结果、并发两个 Profile、离线/超时/空/partial。
5. `features/agents/` Profile：Global/Workspace 清晰分组，来源按需展开；打开/刷新请求；
   loading/empty/error/forbidden/unsupported；中英文、窄屏、暗色、键盘；实际渲染并检查截图。

协议上线使用 backend 先支持新 request/result、再更新 daemon 的兼容顺序；旧客户端不受
影响，旧 daemon 只能给 timeout/unknown-support。是否增加明确能力协商字段可在 schema
批准时一起决定，不能把库存中 provider 存在当成支持新 query。回滚关闭 Profile 查询并
恢复前一 Daemon artifact，无数据库迁移；Redis 临时结果自然过期。

## 5. 本地已实现切片与仍需确认的决定

- Session：内置 `.builtin-sessions` 精确 ID 恢复、拒绝越界/缺失/歧义；外部 Pi 始终传
  `A/.pi-sessions`，包括 command override；后续已补外部 Pi 的精确文件 resume，并校验原生
  `get_state` 的 ID/文件匹配。最新切片已取消 Codex ephemeral 与 Claude no-session-persistence：
  Codex 选择 `thread/start` 或 `thread/resume`，拒绝恢复错误/返回 ID 不符；Claude 有 ID 时
  传 `--resume`，首条 stream input 也携带该 ID，无 ID 时不传 resume/continue/fork。
  二者拒绝空 ID，不将它当 Reset。Driver 不建立 Session 所有权绑定，不应开放任意用户 ID。
  不改变用户 HOME、全局认证或 Skills。当时的 Restart/Reset 调查见第 7 节，当前实现见第 10 节。
- Claude Skills readiness：修复 `initialize` success 却无合法 commands 仍 ready 的问题；
  接受空和非空的有效列表。这只是原生适配器检查，不新增 provider-neutral 或云端字段。
- 本轮已实现云端 Skills 查询/Profile UI；未实现 Skills assignment/writer，不做 Session 展示。

Agent owner 查看该 Agent 所用 runtime 两组 Skills 元数据的权限已确认，不再限定 Global
列表只能返回给 Computer owner。新 WSS request/result 使用选项 A 的最小字段集；仅枚举
已声明根，不扫描任意外链、祖先、插件或 settings 扩展路径。内置 CoForge 是否读取用户 shared
global Skills 是独立剩余决定，不应借 Session 隔离或模仿 Raft 静默改变。

## 6. 先前 Session 切片验证记录（Skills 最新验证见第 8 节）

- Claude regression：先运行新增的 missing/malformed commands 测试，得到
  `Expected promise that rejects / Received promise that resolved`；修复后通过。
- Claude/Codex resume regression：先复现 supplied ID 被旧 driver 拒绝、fresh Codex 仍为
  ephemeral、Claude 默认禁用 persistence，以及 Codex 接受错误的恢复 ID；分别修复并重跑。
- `mise exec -- bun test packages/daemon/test/session-isolation.test.ts packages/daemon/test/claude-code-agent-adapter.test.ts packages/daemon/test/codex-agent-adapter.test.ts`：43 pass / 0 fail，80 assertions。
- `mise run test`：808 pass / 0 fail（protocol 37、cli 24、agent 10、web 384、daemon 213、computer 140）。
- `mise run check`、`mise run build`、`git diff --check`：通过。
- 本轮 check 首次发现 Codex fixture 的 optional params 类型未收窄；补必填检查后 targeted
  tests、check、build 通过，未关闭任何检查。
- Orb 已安装 Codex 0.153.2 / Claude Code 2.1.260；在临时 HOME/config root 下通过两个真实
  driver 的持久启动/初始化/dispose 探针，未发送 model turn、未使用用户 credentials。
  正向 resume/multi-turn 主要由协议子进程 fixture 验证，不声称真实旧 transcript 的恢复已
  端到端验证；Pi exact-file resume 的 pinned CLI 测试仍通过。
- 早期一次全量测试出现 channel 用例超时，随后全量和该用例 20 次重复通过；尚未定位其
  偶发原因，不能把重跑通过称为修复。外部 provider 检查主要使用真实子进程 fixture，
  不等于已在用户机器的 Claude/Codex/Pi CLI 上逐版本验证。
- 已 fetch、unshallow、rebase 至 `origin/HEAD` 并恢复原未提交文件；复核
  `git rev-list --count HEAD..origin/HEAD` 为 0。未创建子 thread、push、merge、发布或 CR。

改动文件：

- `packages/agent/index.ts`、`src/paths.ts`、`src/runner.ts`、`test/session-isolation.test.ts`。
- `packages/daemon/src/code-agent/{claude-code,codex,pi}/driver.ts`。
- `packages/daemon/test/session-isolation.test.ts`、`claude-code-agent-adapter.test.ts`、
  `codex-agent-adapter.test.ts`、`fixtures/{pi-rpc,claude-stream-json,codex-app-server}.ts`。
- `docs/architecture.md`（Session 作用域说明）、ADR 0002（原生存储决定补充）、本文（证据与未批准方案）。

上述先前切片未改 `.proto`、数据库 schema 或 UI；第 8 节记录后续 Skills query/UI 验证。
所有改动保持未提交，未发 CR，不具备 CR 审批或可合并结论。

## 7. 后续明确要求：Restart 恢复，Reset 新会话，Full Reset 清空工作区

本节保留当时的调查和候选方案；其中“尚未实现”“待批准”和“不采用恢复 fallback”是历史
状态。用户后续已批准并修订为可用性优先，当前实现与限制以第 10 节和 architecture.md 为准。

用户明确否定“恢复统一报错”作为最终方案：前端应支持手动 Restart Agent，停止完成后仍是
原 Session；Reset Session 不下发 `session_id`，创建新会话。不能用 cloud message recovery
重新注入几条消息来冒充 native Session resume；Reset 也不是删除整个 Agent workspace。
后续用户另行确认 Full Reset，并确认 Reset + Start 是一个按钮触发的组合操作。
三个操作的已批准语义及删除范围以 [architecture.md](../architecture.md) 为准；此前的
两按钮方案被覆盖，不把 Full Reset 的清空行为混入 Reset Session。

### Raft 证据与不应照搬的部分

同一 1.0.17 发布产物：

- 约 11857 行 Claude `config.sessionId` 存在时添加 `--resume <id>`。
- 约 13901 行 Codex 根据 `config.sessionId` 选择 `thread/resume(threadId)` 或 `thread/start`。
- 约 30555 行处理 driver `session_init`，更新 Agent 当前 ID，然后上报
  `agent:session { agentId, sessionId, launchId }`；约 30746 行 turn-end 也可更新 ID。
- 约 41397 行接收 `agent:start` 并传递 config；但没有公开 Web 源码证明按钮或数据库的
  exact restart/reset 实现，不能把 daemon 侧证据外推为已核实的完整云端流程。
- Raft 的 Claude 使用 UUID resume，Codex 默认 home 仍为用户 `~/.codex`；不能据此声称
  Raft 为两者做到了“文件只存 A、绝不搜索全局”。约 28576 行 `resetWorkspace` 会递归删除
  整个 Agent data directory，**不能拿它实现用户要的 Reset Session**。

### 追加核实：Raft 是否实现了独立存储根与全局配置复用

结论：公开 1.0.17 的默认启动路径没有实现这套隔离，不能以“对齐 Raft”为理由直接启用
Claude/Codex 的全局 ID resume。以下行号均针对第 1 节带校验和的官方发布产物：

| 位置 | 直接证据与边界 |
| --- | --- |
| `prepareCliTransport`，约 11060 行 | `spawnEnv` 按宿主 `process.env`、runtime 显式 `envVars`、driver `extraEnv` 合并；没有自动设置 per-Agent HOME/config root。Agent cwd 和 CLI wrapper 目录不等于 Session 存储隔离。 |
| `buildClaudeProviderIsolationEnv`，约 11536 行 | 名称中的 isolation 是清理未显式配置的认证/模型/provider 环境变量，普通配置返回空对象；不是隔离 Session 或重定向 `CLAUDE_CONFIG_DIR`。 |
| Claude spawn，约 12340 行 | 传上述环境并设置 `cwd=workingDirectory`；明确警告旧 `.slock/claude-provider/home/.claude` 已不再使用，原文为 “custom-provider Claude now uses host Claude state plus explicit provider env.” 旧目录存在不代表当前仍使用。 |
| `resolveCodexHomeRootFromConfig/Env`，约 12428–12455 行 | 优先显式 `CODEX_HOME`，否则宿主 `os.homedir()/.codex`；相对路径按 cwd 解析。没有根据 Agent ID 自动生成独立根。 |
| Codex resume error，约 14108 行 | 某些分类错误会走 `fallback_fresh_thread` 并发送 recovery 事件；这不是静默处理，但仍不符合本次“只有 Reset 才新建”的要求。 |

允许显式 runtime 环境覆盖，不等于默认按 Agent 隔离；公开 daemon 产物也不足以排除私有
Web/backend 会向特定安装下发额外环境配置。1.0.18 官方 package 仍不可得，不能把结论
推广为所有 Raft 版本都没有隔离。包没有可核实的复用许可；只借鉴行为设计，不复制源码。

可借鉴的设计是“实际 Session ID + launch 标识上报、带 ID resume、不带 ID start”与
Skills 的按需双 scope 元数据响应。用户后续确认共享 Claude/Codex 原生 Session 根，故不再
实施独立 config home；恢复仅在确认缺失或启动期可安全判定不可重放时使用新 ID fallback，
认证、网络、歧义、权限、损坏、I/O 与未知错误仍失败。删除整个 Agent workspace 仅限后续
明确确认的 Full Reset，不能用于普通 Reset Session。保留宿主状态
确实避免隔离根导致登录/全局配置/Skills 来源变化，但公开产物不足以证明这就是 Raft 团队
唯一的设计动机。不据此扩大 CoForge 的环境变量透传范围。

### 当时缺少的完整链路（已由第 10 节实现）

当时缺口是 provider-neutral identity seam、可靠 WSS report、云端绑定与 Full Reset 防重放；
这些批准前调查解释了第 10 节的实现顺序，不再作为当前缺口或候选契约重复维护。Pi 的
identity observation 仍不等于 transcript 已 flush；依据是
[Pi v0.84.3 SessionManager](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/src/core/session-manager.ts)
的延迟 `_persist`。当前事实与剩余限制以第 10 节及 architecture.md 为准。

### Claude/Codex 的原生存储限制与候选方案（已选择原生全局存储）

| Provider | 当前官方能力 | 对隔离的影响 |
| --- | --- | --- |
| Pi | `--session-dir A/.pi-sessions --session <exact-file>`；RPC `get_state` 返回 ID/file | 本次已接入并用 pinned v0.84.3 CLI 验证；先按 cwd 与精确 ID 查本目录，不走 CLI 前缀/global fallback。 |
| Claude | `--resume <uuid>`；`CLAUDE_CONFIG_DIR`；`CLAUDE_CODE_PROJECT_DIR_NAME` | 当前 UUID lookup 可跨项目；重定向配置根也会重定向 credentials、全局 Skills、settings/plugins，没有稳定的 session-only root flag。 |
| Codex | 持久 `thread/start` + `thread/resume(threadId)`；`CODEX_HOME` | `ephemeral:true` 必须取消；sessions 在 CODEX_HOME 下，但该根也包含 auth/config/skills。cwd 不是 session storage root。 |

官方来源：[Claude Session storage/lookup](https://code.claude.com/docs/en/sessions)、
[Claude config directory](https://code.claude.com/docs/en/claude-directory)、
[Claude CLI](https://code.claude.com/docs/en/cli-reference)、
[Codex app-server](https://developers.openai.com/codex/app-server)、
[Codex ThreadResumeParams](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadResumeParams.ts)。
源码 main/滚动文档不等于用户安装版本；应按实际 CLI 生成 schema/执行兼容测试。
Codex 的 exact-path resume 在当前 Rust schema 属 experimental；Claude transcript file resume
在 changelog 出现但稳定 CLI reference 未承诺，不应默认依赖它们或手工改写内部 transcript。

调查时比较的方案（用户随后选第二项）：

- **严格物理隔离**：为 Claude/Codex 建 A 内专属 native config home。原生存储/恢复稳定，
  但须设计受控的全局认证、配置、Skills 引用或独立登录；不能静默丢失用户原来的全局能力。
  不复制 global skills、不改写 HOME；选择性 symlink/配置引用是否允许、哪些可写目标可共享，
  是安全边界决定。当前不采用，不能声称已经验证所有原生配置可透明保留。
- **保留原生全局存储（已选）**：driver 交给原生 API 恢复指定 ID；云端恢复链路必须只传
  CoForge 为该 Agent 记录的绑定，driver 的 cwd 不是所有权检查。迁移较小且保留用户配置，
  文件不在 A，Claude 内部仍可能扫描全局；用户已明确放宽两者的物理存储/内部查找限制。
- **外部 SessionStore/实验性路径**：Claude SDK SessionStore 需迁移当前 driver 并验证本地
  mirror 行为；Codex experimental path 不能控制新 session 初次落盘。维护/兼容成本较高，
  不作为这次默认方案，不新增 dependency 或改变 license。

Session identity 的 WSS/数据库绑定已在第 10 节实现；Skills 查询不替代这条链路。

## 8. Profile Skills 实现与本轮验证

- `packages/protocol/agent-skills.ts` 与 `.proto` 定义独立 request/result、类型区分与
  scope/字段/长度限制，未改变原有 inventory schema 或 PostgreSQL schema。
- `packages/daemon/src/code-agent/agent-skills.ts` 只读解析 native roots 的 frontmatter；
  Claude legacy commands 允许递归 Markdown，Pi 根 Markdown 仍要求 frontmatter。
  同名条目保留不同来源，**不替 provider 推断哪条实际生效**。全局目录由用户/provider
  管理，本查询没有 writer；受限符号链接与异常文件返回 partial，不上传正文或绝对 HOME。
- `connection/daemon-connection.ts` 与 `daemon-runtime/runtime.ts` 处理二进制请求及结果，
  从稳定 IDs 计算 A；仅扫描当前 Computer/Workspace，不创建 driver 或 Session、不 reload，
  不更新 inventory。现有启动额外环境只有 COFORGE_* capabilities，因此默认 native roots
  与启动环境一致；future 自定义 runtime env 必须同时接入 query，不能只改启动端。
- Web `server/agents/agent-skills.server.ts`、`server/centrifugo/agent-skills-cache.server.ts`
  与 `rpc-composition.server.ts` 负责 owner/membership/assignment 重验、Redis 原子首响应
  接收和可信 daemon claims 校验；Profile 的 `agent-skills.functions.ts` 是 no-store POST，
  只接受合法 Agent UUID。结果不跨请求缓存；30 秒过期，完成/超时清理。
- `features/agents/agent-skills.tsx`、`agent-detail.tsx`、Agent route 与中英文 messages：
  仅 owner 的 Profile 挂载/刷新触发；Global/Workspace 分表、名称/描述/来源列、目录展开，
  loading/offline/timeout/error/partial/unsupported 与成功空列表分开；忽略旧 assignment
  响应。明确不是 loaded status，插件和额外配置来源未包含。
- Oracle 定向审查发现 Claude control initialize 后仍可能收到错误的 `system/init` ID。
  现已校验非空且与指定/已建立 ID 一致，违例通过 adapter-authored `JsonlProtocolError`
  终止进程、拒绝排队通知并丢弃同批后续 text/completed。不能把 ready 延迟至 system/init，
  因为 CLI 需要先收到初始输入才发该事件。三种非法 ID 回归覆盖该失败顺序；这不是完整
  云端 Session 所有权审查或真实 Claude/Codex 历史 transcript 恢复的端到端声明。

验证入口：

```sh
mise run test
mise run check
mise run build
# 两个变量必须指向 Orb 本地测试 PostgreSQL/Redis，不是共享环境：
mise exec -- bun test ./apps/web/test/agent-skills.integration.ts
```

最终常规检查：`mise run test` **830 pass / 0 fail**（protocol 38、cli 24、agent 10、
web 398、daemon 220、computer 140）；`mise run check` 与 `mise run build` 退出码 0，
包括 buf lint/format 与 TypeScript 检查。独立 PostgreSQL/Redis 集成测试 **2 pass / 0 fail，
14 assertions**。没有通过跳过测试、增加重试或放宽断言来获得通过。

集成测试使用 `SKILLS_TEST_DATABASE_URL`、`SKILLS_TEST_REDIS_URL`，验证 Agent owner 与
Computer owner 分离、撤销成员资格、Computer 解绑，以及 unsolicited/mismatched/
duplicate/cancelled/expired result。常规测试另覆盖配置/移机竞态、离线/超时、RPC claims、
WSS→Daemon→result、只读目录重扫、损坏 frontmatter、越界链接、provider 初始化和 resume。

实际浏览器验证使用本地 PostgreSQL/Redis/Centrifugo、真实 DaemonConnection 与目录扫描，
provider 进程不启动；只创建清晰标注的临时 Skills fixtures。已观察 Profile 首次请求返回
Global 两条、Workspace 两条；修改目录加入损坏文件后点击刷新显示 partial，原两条有效
Workspace Skills 保留，正文未出现在页面。桌面与窄屏/暗色渲染记录保存在当前 Amp thread。
窄屏发现 Profile 自动列宽使新表格随其他字段外溢，改为单列 minmax 布局并允许长字段换行。
最终 390px 视口 `scrollWidth=390`，两个表格均实测可滚至各自 `scrollLeft=324`；
离线后 DOM 为零张表格并明确显示 Computer 离线，不保留旧结果。中文桌面、英文暗色
窄屏、partial 与 offline 截图均已检查。临时目录、数据库 fixtures 与预览 Daemon 已清理。

没有 push、merge、release、子 thread 或 CR。剩余项是内置 CoForge shared Global 读取决策，
以及 Skills assignment 的输入来源/writer。

## 9. 三种操作的历史契约提案（已由后续批准和第 10 节取代）

以下保留当时待审的方案与证据，不代表当前状态。用户随后批准新增 Session wire、独立
Session 表、当前控制 JSONB 与持久化重放防护，并修订恢复策略为可用性优先。下文中的
“待批准”“未实现”“恢复失败不 fallback”均为历史状态，当前契约见 architecture.md。

### 直接检查到的缺口

- `PublishAgentRuntimeControl.start/stop` 仅等待 Centrifugo publish；返回不代表 Daemon
  已启动或停止。`agent:status` 是租约，`agent:activity` 是 best-effort；两者均不是关联到
  本次控制请求的完成确认。现有 Message ACK 只确认消息接受，不可挪用为 Stop ACK。
- `DaemonRuntime` 对同一 Agent 等待 stop Promise，提供本进程内的替换顺序，未提供跨
  Daemon 重启的 Full Reset 去重。`AgentProcessManager.stop` 会删掉内存 restart config。
- `AgentSession` 没有读取/订阅真实 Session identity 的接口；新建 ID 保留在 provider 内。
  `Agent` schema 只有 `runtimeConfig`，没有绑定或代际；Web ready recovery 不传 Session ID。
- `agentWorkspaceDirectory` 只验证路径安全的 ID 并拼接目录，不做物理目录或祖先 symlink
  检查。它可以用于命名，不能单独证明递归删除安全。

### 候选与建议

| 方案 | 收益 | 不满足的条件/成本 |
| --- | --- | --- |
| 仅前端依次发送现有 Stop/Start | 无 schema 迁移 | 缺真实 ID；publish 不是完成；重连可能插入启动；不能实现安全 Full Reset，拒绝 |
| 仅内存记录 ID、Reset request ID | 本次 Daemon 存活期间实现简单 | 重启丢绑定和去重，重复删除可能清掉新进程文件，拒绝作为完整方案 |
| 每 Agent 当前 Session 绑定＋控制代际＋窄范围 Reset 进度 | 可以拒绝旧结果、恢复当前会话、阻止清空重放 | 新 wire/数据库及本地持久化契约，需要批准；推荐 |

推荐方案继续使用现有 Bun、protobuf、PostgreSQL/Prisma、Redis 与单条 daemon WSS；
不引入新框架、license、provider 依赖或运行时版本。Raft 的实际 Session ID＋launch 上报
提供行为参考，但不能证明其私有云端的事务、重放和删除安全性，相关实现由 CoForge
自行拥有。官方原生 resume/持久化证据见第 7 节，不能用内存去重冒充磁盘保证。

### 建议批准的契约范围

1. **Provider-neutral identity seam**：`AgentSession` 提供当前 identity 及变更通知，避免
   在 subscribe 前已经初始化而漏报；区分 unknown、尚未持久化、可恢复。Provider 解析
   仍留在 driver，不上传 Session 正文或路径。Pi 空会话延迟落盘必须用原生探针验证；
   缺文件/不明状态不能伪装恢复成功，也不能擅自降级新会话。
2. **可靠 WSS report 与控制结果**：新增 Session identity report 和按请求关联的
   start/stop/reset 结果；关联 Workspace、Computer、Agent、provider、control epoch、
   start request 与 launch。只接受可信 Daemon claims 及当前授权操作。云端确认落库后
   ACK Session report，重连重发当前未确认快照；不复用 Activity 或 Computer inventory。
   Full Reset 使用专用、明确区分的 reset request，不能把未知可选字段附到旧 start 后
   假定旧 Daemon 执行了删除。三种按钮共用后端流程，保留独立 start/stop intents，不加
   `agent:replace`。
3. **Web 当前绑定与代际**：按 Agent 持久保存 Session binding 的完整 assignment scope、
   当前控制 epoch/request 及进度；在既有 per-Agent runtime lock 下变更。新操作提升
   control epoch，Restart 保留绑定，Reset 在确认旧进程停止后清绑定。Session report
   handler 做条件更新，旧 epoch/launch 报告不能复活旧绑定。等待 Daemon 结果时不能
   占住 report handler 也需要的锁，否则造成 ACK 死锁。
4. **恢复和授权一同收口**：create、手动操作、配置变更、凭据变更、ready recovery 与
   启动授权读取同一当前控制状态。Reset 未完成时不得由 ready recovery 绕过并启动；
   启动授权必须校验当前 epoch/request/config，而不是只凭 Agent ID。禁止跨 Computer/
   provider 恢复或让浏览器指定任意 native Session ID。
5. **Daemon 窄范围持久化防护**：在待删除的 Agent workspace **之外**保留该 Agent 当前
   epoch、reset request 和清空进度；停止确认后持久记录清空中，清空后先持久记录已清空，
   再允许新 launch。相同 request 在已清空状态只能继续 start/返回结果，绝不再次删除。
   清空中崩溃只能在确认无存活旧进程后继续清空；异常/损坏/丢失的防护记录不能被当成
   “尚未执行”盲目重删。新会话绑定丢失或写入失败也不得盲目新建冒充重试成功。
   具体原子写入、crash recovery 与旧子进程回收顺序要先做受控故障测试。
6. **不是通用命令平台**：仅保存每 Agent 当前控制/Session 事实与 Full Reset 防重放进度；
   不建通用 jobs 表、历史命令队列、claim/lease worker 或数据库 mailbox。若实现需要
   自动执行的通用持久命令队列，必须另提架构决定，不能借本提案扩张。
7. **UI 完成标准**：同一 Agent 一次只允许一个控制操作；Full Reset 确认框始终显示删除
   Workspace Skills/隐藏文件且不可撤销。超时显示结果未知而非成功，查询当前 operation
   或重试同一 request；不能自动用新 request 再做一次破坏性操作。显示流程进度不新增
   Agent online/offline 之外的业务状态。

### 切片验收、兼容和回滚

批准后先确认测试 seam：provider `AgentSession` identity；`DaemonRuntime` lifecycle；
Web Agent lifecycle use case 与有条件的数据库绑定；协议 codecs/result receiver；Profile。
逐片 red→green，不能只测按钮依次调用了两个函数：

- 四种 driver 首次 identity、恢复同 ID、初始化期间漏报、错误 ID 与 Pi 空会话落盘；
- Restart Stop 失败不 Start、非分类恢复错误不 fallback、Reset 保留所有 workspace 文件；
- Full Reset 清掉隐藏文件但不删除 HOME/兄弟 Agent，根或祖先链接拒绝，内部外链不跟随；
- 清空前/中/后以及 Start 后崩溃，重复请求绝不删除新文件；失败不创建第二个进程；
- PostgreSQL 旧 report 与 Reset 交错、两个控制操作并发、撤权/移机/换 provider；
- ready recovery/启动授权与 Reset 交错，超时结果重查，旧 Daemon 不支持时不执行降级流程；
- 三按钮单操作体验、禁用/错误/确认状态，中英文/窄屏与真实 Daemon 完成结果联调。

上线需要先部署兼容 receiver/加法迁移，并在确认 Daemon 支持完整控制契约后启用按钮；
不把 provider inventory 存在当成新协议能力。旧 Agent 没有绑定时不得扫描全局并选择
“最近 Session”，必须显示恢复不可确认。回滚关闭操作入口，保留绑定及防重放记录，
禁止旧 Daemon 绕过未完成 Reset 恢复；清空的用户文件无法由代码回滚恢复。迁移/发布本身
仍需单独授权。当前未实现或验证这些新的 wire/schema/crash-recovery 保证。

## 10. 批准后的实现结果

- Provider-neutral `readSessionIdentity()` 与 Session 事件接入四种 driver。Web 的
  `AgentControl`、Daemon 的 `AgentControl` 和 `PrismaAgentControlStore` 分别拥有云端
  授权/条件状态、本地控制防护、Session 行与当前绑定；内置 runner 通过原生 `sessionId`
  getter 提供 identity。`AgentSession` 是 native ID/state 的唯一持久化所有者，
  `runtimeSession` 仅保存 provider/computer/startRequestId/daemonInstanceId/launchId/sessionMode
  launch fence，`controlState` 仅保存当前 epoch/action/phase/sequence 进度；不新增 runtime
  inventory 字段。
  后续按用户要求将 Session 同步拆出：Daemon `AgentSessions.update/replay` 独立更新、
  发送和重放当前快照；Web `AgentSessionReceiver.accept` 独立接收。统一 RPC callback 将
  Session report 交给 acceptance seam；带 sequence 的 snapshot 先验证上游 launch fence，
  再交给独立 receiver。共享记录串行化和 scope/条件写入保留，Control 不再观察或发送
  Session 更新。
- Restart 保留非空绑定；Reset Session 和 Full Reset 均确认停止后清绑定并自动 Start。
  runtime 切换新建 Session。已知空会话不下发 ID、不生成 recovered 或错误提示；正常
  identity 仍落库。已分类启动恢复错误清理后只 fresh retry 一次，不泛化到认证/网络错误。
- `AgentSessionReport` 保留上游 tag 1–12，增加 `control_epoch` 13、`sequence` 14、
  `session_state` 15；`agent:start` 保留 `previous_launch_id` 16、`session_mode` 17，增加
  `control_epoch` 18。
- Profile 参考用户提供的 Raft 页面，只保留一个 Restart 入口；弹窗内选择 Restart、
  Reset Session & Restart 或 Full Reset & Restart，再以一个按钮确认所选组合操作。
  Full Reset 显示不可逆删除警告；窄屏正文可滚动，确认操作栏保持可见。
  用户后续明确不需要按钮等待态或进度面板，
  已去掉前端控制状态查询、pending/完成展示与独立重试面板；按钮直接提交，提交失败
  保留反馈，运行情况看 Agent Activity。内部停止确认、条件更新和防删除重放不变。
  Skills 继续是 owner-only 按需 Global/Workspace 元数据，不上传正文，不声称实际加载成功。
- 加法迁移 `20260908120000_agent_session_binding` 仅应用于 orb 的本地 PostgreSQL。
  `agent-session.integration.ts` 验证 fresh recovery 新建行、保留旧 native ID、同 launch
  禁止换 ID；`agent-control-runtime.test.ts` 穿过真实 DaemonRuntime 验证三操作、重放、
  正常 Daemon 重启、runtime 切换和一次恢复 fallback（provider/transport 为受控替身）。
- Oracle 对两个具体 Full Reset/孤儿进程不变量提出问题后，已补充：缺失防护记录且存在
  未跟踪 workspace 时拒绝继续；启动失败后必须确认 stop，不能把可能存活的进程写成
  安全终态。单元回归覆盖；不声称任意硬崩溃后的自动进程协调已实现。
- 后续用户要求补功能联调，新增 `apps/web/test/agent-control.e2e.ts`：真实浏览器按钮、
  Web、PostgreSQL、Redis、Centrifugo WSS、DaemonRuntime 和 PiDriver，只有原生 Pi
  child 使用确定性协议 fixture（不调用付费模型）。临时独立 Computer/Agent/目录及
  fixture HOME，不 TRUNCATE、不 FLUSHDB、不写用户真实 Global Skills，结束后清理。
  联调先暴露回合结束后 Session 状态未刷新的问题；补上 driver identity 读取和上报后，
  联调覆盖空 Session 静默新建、非空精确恢复、旧 child 已退出、Reset 保留文件、
  Full Reset 删除范围和取消确认、Skills 只返回元数据、正常 Daemon 重启恢复。
  后续补实际浏览器 Activity 断言，修复测试代理未转发 `centrifuge-protobuf` 导致浏览器
  收不到事件的问题；验证重启产生 Starting/Stopped，而非另设控制进度面板。
  弹窗测试等待实际可见 Dialog 关闭，而非要求 keepMounted 的隐藏 Dialog 从 DOM 删除。
  实测 390px 窄屏下确认按钮在视口内，正文滚动后完整警告位于操作栏上方；桌面三选项、
  窄屏和实际 Activity 截图均已检查。运行需启动本地 `.amp/services.yaml` 服务并等待
  Web `/health` 就绪，然后
  注入本地 `DATABASE_URL` 并执行
  `COFORGE_CONTROL_E2E=1 mise exec -- bun test ./apps/web/test/agent-control.e2e.ts`。

本次最终验证：`mise run test` **896 pass / 0 fail**（Web 410、Daemon 243、Computer 166、
protocol 43、CLI 24、Agent 10）；`mise run check`、`mise run build` 和 `git diff --check`
通过。上述浏览器联调 **1 pass / 0 fail，28 assertions**；本地 PostgreSQL Session
集成 **1 pass / 0 fail，5 assertions**；Daemon/Web Session 并发回归
`mise exec -- bun test ./packages/daemon/test/agent-session.test.ts ./apps/web/test/agent-session.test.ts --rerun-each 30`
共 **60 pass / 0 fail，750 assertions**。服务重启后一次过早运行因 Web 尚在构建而连接失败，
确认 `/health` 就绪后运行通过；没有将该环境失败伪装成产品测试通过。

剩余限制：缺失/损坏记录或硬崩溃遗留危险状态需要人工诊断，当前可能保持 pending；
没有自动孤儿进程协调、旧停止 workspace 收养或新旧 Daemon 能力协商。启动后才出现的
provider replay 错误尚不走自动 fallback。内置 CoForge shared Global 读取策略和 Skills
assignment/writer 输入来源仍未决定。Raft 1.0.18 官方 package 当前不可取得，其实现和
Raft 私有云端仍不可验证。
不把这些限制写成已完成保证，也不删除防重放记录来绕过安全检查。
