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
- [ ] 运行 `bun run ui:sweep`，检查各页面无明显溢出、遮挡、空白或响应式布局问题。
- [ ] 手工验证菜单、Dialog、Tooltip、键盘导航、Escape 关闭、触摸操作与滚动位置。
- [ ] 手工验证频道/私聊消息发送、线程切换、历史加载、Realtime 状态与错误恢复。
- [ ] 手工验证 Agent/Computer 控制、运行时配置、Usage、安装命令与重启反馈。
- [ ] 手工验证 Records 编辑器、周报模板、Tasks Board/List、任务创建与状态变更。
- [ ] 手工验证设置保存、主题/语言/时区、Workspace 切换、登录与错误状态。
- [ ] 记录每个 Todo 的验证结果、浏览器/viewport、主题和发现的问题；不新增 UI 单元测试。

## General principles

- Test observable behavior through the owning module's public contract rather than private implementation details.
- For bug fixes, first demonstrate the failure with a regression test, then make the smallest implementation change that passes it. Follow the existing `tdd` guidance for behavioral changes.
- Keep assertions specific to the behavior under test. A test should fail when that behavior breaks, not pass because unrelated output happens to contain the expected value.
- Distinguish production defects, incorrect test assumptions, and environment failures using evidence before changing code or expectations. Preserve valid assertions and report unresolved failures honestly.

## Async and concurrent tests

- Wait for observable completion through the public contract: a returned Promise, status event, or acknowledgement. Do not use `sleep`, timer ticks, or arbitrary microtask flushing as proof that unrelated async work has completed. Time-based behavior may use controlled clocks or real timers when the clock itself is under test.
- Assert only ordering guaranteed by the product contract. When operations become concurrent, revisit existing ordering assertions; verify required per-Agent ordering and eventual completion without assuming a global completion order.
- Use controllable Promises at existing external boundaries to force slow operations and relevant interleavings. Release gates and clean up runtimes in `finally`, including when assertions fail. Do not expose private implementation solely for test synchronization.

## Investigating intermittent failures

- Retain the failing command and output, construct a controlled reproduction, and determine whether the defect is in production behavior or test synchronization. A passing rerun is diagnostic evidence, not a fix; do not mask failures with retries, skipped tests, longer timeouts, or weaker valid assertions.
- For concurrency changes and flaky-test fixes, run bounded repetitions of the affected tests in addition to the normal checks. Record the command, repetition count, and failures in the CR; for example, `mise exec -- bun test <test-file> --test-name-pattern '<affected tests>' --rerun-each 100`. Repetitions supplement controlled interleavings, not replace them; do not repeat the entire suite in every CI run by default.

## Review

- An independent reviewer must check which public behavior each test protects and whether breaking that behavior would make the test fail. For async/concurrent tests, also ask: "What observable completion does this test await?" and "Which contract guarantees each asserted ordering?"
- If a test is changed instead of production code, require evidence that its previous assumption was invalid and that the intended behavior remains covered. Unexplained intermittent failures must not be reported as verified or ready to merge; escalation must preserve the failing evidence rather than silently defer it.
