# Testing

Read and follow this guidance when writing or modifying tests, investigating
test failures, or reviewing test changes. Apply the sections relevant to the task.
It supplements the existing `tdd` workflow; it does not require unrelated tasks
to add tests or run stress checks.

## UI verification policy

> 禁止 UI 单元测试，列出本次改动受影响的 UI 并给出测试 Todo list，我自行验证。

本次删除 UI 单元测试后，受影响的 UI 范围包括：

- Agent：成员列表、详情 Profile/Activity/Reminders、运行时配置、环境变量、Skills、控制操作、状态与 Activity avatar。
- Computer：列表与详情、运行时 Usage、安装命令、身份展示、重启反馈。
- Conversation：频道与私聊、消息历史、线程、Realtime 状态、导航与侧栏。
- Records：记录布局、周报设置、模板父子页面、代码块与表格编辑器。
- Tasks：Board/List、任务概览、状态拖拽与创建流程。
- Settings/Auth：AppShell、Preferences、Login、Workspace switcher、错误页。
- Landing 与基础 UI：Landing page、Toast、ComboBox、Tooltip/Dialog，以及 UI lint/sweep 辅助行为。

### Manual verification Todo list

- [ ] 启动 Web 应用并准备可用的开发 seed 数据。
- [ ] 在桌面与移动 viewport 分别验证上述页面；至少覆盖 light 与 dark 主题。
- [ ] 运行 `bun run --cwd apps/web ui:sweep`，检查各页面无明显溢出、遮挡、空白或响应式布局问题。
- [ ] 手工验证菜单、Dialog、Tooltip、键盘导航、Escape 关闭、触摸操作与滚动位置。
- [ ] 手工验证频道/私聊消息发送、线程切换、历史加载、Realtime 状态与错误恢复。
- [ ] 手工验证 Agent/Computer 控制、运行时配置、Usage、安装命令与重启反馈。
- [ ] 手工验证 Records 编辑器、周报模板、Tasks Board/List、任务创建与状态变更。
- [ ] 手工验证设置保存、主题/语言/时区、Workspace 切换、登录与错误状态。
- [ ] 记录每个 Todo 的验证结果、浏览器/viewport、主题和发现的问题；不新增 UI 单元测试。

## Browser end-to-end tests

- `apps/web/test/*.e2e.ts` are opt-in: `bun test` does not discover `.e2e.ts`, and CI never runs them. They need a local Web service, `agent-browser`, and a local database. Each file's doc comment states its own prerequisites and what it writes under `.amp/e2e/`.
- Run one by name: `mise run test:e2e:web` lists them, `mise run test:e2e:web <file>` runs one (the `.e2e.ts` suffix is optional). Use `scripts/e2e/run-web-e2e.sh` directly when you want the listing without mise.
- **Pass the file as a path, never as a bare name.** `bun test e2e-x.e2e.ts` treats the argument as a *filter* and runs zero tests, printing only a hint; `bun test ./test/e2e-x.e2e.ts` loads the file. The two spellings differ by one `./`, and `scripts/ci/test-invocations.test.ts` guards the invocations that scripts, `mise.toml` and workflows name.
- The shared runner defaults `COFORGE_E2E_WEB_URL` to `http://127.0.0.1:8788`, the dev server's port (the same default `run-mobile-overflow.sh` uses). The standard managed stack publishes Web on **8789** instead, so a file run against that one needs `COFORGE_E2E_WEB_URL=http://127.0.0.1:8789`.
- A file that needs more than the shared environment (Centrifugo, the worker key material, a provider key, a viewport) has its own runner and mise task; run it through that one. The shared runner sets `DATABASE_URL`, `REDIS_URL` and `COFORGE_E2E_WEB_URL` only.
- A new browser e2e needs no wiring to become reachable: the runner lists the directory, so it is runnable the moment the file exists. Its prerequisite checks must throw with the missing value named, never skip silently, so that an unrun test is visibly unrun rather than green.

## Integration suites

- `apps/web/test/*.integration*.ts` are 88 files that CI never runs (its jobs have no PostgreSQL). Run them all through `mise run test:integration:web` with `INTEGRATION_DATABASE_URL` (and `INTEGRATION_REDIS_URL` for the Redis-backed ones). The runner exports every per-area `<AREA>_TEST_DATABASE_URL` (and the two `_TEST_REDIS_URL`) from those variables, and `scripts/ci/integration-env.test.ts` guards that its list stays complete. The runner's own header holds the list; a count here would rot.
- **A file run by name silently skips rather than failing.** Each integration file guards on its own variable, so with none set `bun test test/agent-events.integration.ts` prints `0 pass, 13 skip, 0 fail` - which reads like a pass and is not one. Use the runner, or set that file's own `<AREA>_TEST_DATABASE_URL`.
- Eight of them are Centrifugo-backed, needing `COFORGE_CENTRIFUGO_API_URL`/`KEY`; one needs a built `.output/server`. Without those they fail as a group, and the failures look like product defects in the log (`conversation_realtime:*_failed`) while being environment. Classify by running the same runner on the base commit with the same database before concluding anything about a branch.

## General principles

- Test observable behavior through the owning module's public contract rather than private implementation details.
- For bug fixes, first demonstrate the failure with a regression test, then make the smallest implementation change that passes it. Follow the existing `tdd` guidance for behavioral changes.
- Keep assertions specific to the behavior under test. A test should fail when that behavior breaks, not pass because unrelated output happens to contain the expected value.
- Distinguish production defects, incorrect test assumptions, and environment failures using evidence before changing code or expectations. Preserve valid assertions and report unresolved failures honestly.

## Async and concurrent tests

- Wait for observable completion through the public contract: a returned Promise, status event, or acknowledgement. Do not use `sleep`, timer ticks, or arbitrary microtask flushing as proof that unrelated async work has completed. Time-based behavior may use controlled clocks or real timers when the clock itself is under test.
- Assert only ordering guaranteed by the product contract. When operations become concurrent, revisit existing ordering assertions; verify required per-Agent ordering and eventual completion without assuming a global completion order.
- A test that really spawns a child process (a provider fixture, a Daemon) sets its own `bun:test` timeout to at least the product's bound for that operation, built from the product's exported constants (for example `CATALOG_DISCOVERY_BUDGET_MS` in `packages/daemon/test/catalog-discovery-budget.ts`). Never raise the global timeout. Below the product's bound the runner ends a healthy but slow run before the product's own deadline can, and the abandoned test keeps running into the next one.
- Use controllable Promises at existing external boundaries to force slow operations and relevant interleavings. Release gates and clean up runtimes in `finally`, including when assertions fail. Do not expose private implementation solely for test synchronization.

## Temporary files and machine-wide state

- A test removes every directory it creates under the OS temp root, in `afterEach`/`afterAll` or a `finally`, whether it passes or fails. Register the path when you create it (`mkdtemp`, or a random-suffix path a component creates), not afterwards. Injecting a stub `remove`/`cleanup` into the code under test is not a reason to leave its real directory behind.
- State that defaults to a machine-wide directory shared by every process of the user (the Agent send drafts and consumed cursor under `tmpdir()/coforge-cli-*`) must not be written by a test. Test packages that can run a `DaemonRuntime` (`packages/daemon`, `apps/web`) preload `packages/daemon/test/cli-temp-state.preload.ts` from their `bunfig.toml`, which points `COFORGE_CLI_DRAFT_STATE_DIR` and `COFORGE_CLI_CONSUMED_SEQ_STATE_DIR` at a directory of the test process's own. Extend that preload for another override rather than adding a second mechanism, and never change a production default to make a test tidy.
- Measure leaks with a fresh `TMPDIR` (`TMPDIR=$(mktemp -d) bun test`), then list it: only third-party tool directories (`jiti`, `kiro-log`, ...) may remain.
- Process environment is machine-wide state a test reads as well as writes. A test whose
  assertion is about behaviour derived from an environment variable gives the process the value
  that behaviour needs, clears the variable it does not, and restores the host's value — absence
  included — in a `finally`/`afterEach`: proxy settings and `NO_PROXY`, locale, `PATH`, an
  injected `GIT_CONFIG_*`. Inheriting the value lets the host, not the code, decide the outcome,
  so a defect in that code reads as an environment failure and the suite disagrees with CI. When
  the runner applies the process value on top of the argument under test (Bun's `fetch` honours
  the process `NO_PROXY` beside a per-request `proxy`), say so in the test and clear the process
  variable there. Baseline a failure that appears in only one environment against the same test
  file on a clean `origin/main` in the same worktree before reading it as a regression.

## Investigating intermittent failures

- Retain the failing command and output, construct a controlled reproduction, and determine whether the defect is in production behavior or test synchronization. A passing rerun is diagnostic evidence, not a fix; do not mask failures with retries, skipped tests, longer timeouts the product's bounds do not justify, or weaker valid assertions.
- For concurrency changes and flaky-test fixes, run bounded repetitions of the affected tests in addition to the normal checks. Record the command, repetition count, and failures in the CR; for example, `mise exec -- bun test <test-file> --test-name-pattern '<affected tests>' --rerun-each 100`. Repetitions supplement controlled interleavings, not replace them; do not repeat the entire suite in every CI run by default.

## Review

- An independent reviewer must check which public behavior each test protects and whether breaking that behavior would make the test fail. For async/concurrent tests, also ask: "What observable completion does this test await?" and "Which contract guarantees each asserted ordering?"
- If a test is changed instead of production code, require evidence that its previous assumption was invalid and that the intended behavior remains covered. Unexplained intermittent failures must not be reported as verified or ready to merge; escalation must preserve the failing evidence rather than silently defer it.
