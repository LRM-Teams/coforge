# ADR 0063: Upgrading is a state of the Computer, not of the click that started it

Status: proposed
Date: 2026-09-22

## Context

On 2026-09-22 a Workspace member upgraded a Computer to `0.1.0-dev.75` and the
Computer page told them **"The previous upgrade's result has not been confirmed
yet"**, with a step telling them to restart the Computer supervisor. Nothing had
failed. The machine's own records for that upgrade:

| time (UTC) | evidence on the machine |
| --- | --- |
| 10:06:21 | `upgrade-results/95e10fe7-….request.json` — operation recorded pending, target `0.1.0-dev.75` |
| 10:08:39 | `coforge-computer status` — `unsettled upgrade: 95e10fe7-… -> 0.1.0-dev.75 state=pending age=138s` |
| 10:08:0x | `upgrade-results/95e10fe7-….result.json` — `{"status":"succeeded","version":"0.1.0-dev.75"}`; `active -> versions/0.1.0-dev.75` |

A healthy upgrade took about two minutes. Three separate mechanisms turned that
into a failure on screen:

1. **The panel's state is the click's, not the Computer's.**
   `runUpgrade` (`apps/web/src/features/computers/computer-detail.tsx`) holds
   progress in component state and polls with the *restart* window
   (`RESTART_MAX_POLLS` 31 × `RESTART_POLL_INTERVAL_MS` 2000 ms ≈ 62 s) — sized
   for an in-process restart, not for an external job that switches two
   executables. It gave up while the job was still healthy, cleared the shared
   "upgrading" indicator, and left the button clickable.
2. **A conflict rendered as a failure.** The next click was refused with
   `UPGRADE_OPERATION_PENDING` — whose Daemon text is exact: *"Computer upgrade
   operation 95e10fe7-… is still pending; wait for it to finish before starting
   another"* — and `upgrade-failure.ts`'s `CODE_COPY` drew it as a failure with
   the "result has not been confirmed" headline. ADR 0041 deliberately gave that
   code the "check status, then restart `--supervisor` if it stays stuck"
   guidance, but the headline asserted a fault, and the step list read as
   remediation for a job that was running normally.
3. **Nothing survives leaving the page.** `docs/design.md` §13 already
   requires the opposite: *"用户必须看到、必须处理、或者导航离开再回来还要能找到的状态，一律内联显示在受影响的区域里"* and lists
   Computer upgrades among the inline examples ("进行中状态带 spinner 并禁用控件"). Reload mid-upgrade
   today and the page shows neither progress nor the pending operation; the new
   version is only discovered by refreshing again.

The same `pending -> refused -> settled` sequence is in the daemon log for
dev.57 → dev.58 earlier the same day, so this is a repeating experience, not one
bad afternoon.

### What is already right, and must not be redesigned

The machine-side protocol is stronger than the screen suggests and this record
changes none of it:

- the Coordinator holds an **exclusive single pending operation** with a 30-minute
  TTL (`MachineSupervisor.recordUpgrade`, `UPGRADE_OPERATION_PENDING_TTL_MS`), and
  settles a blocker that is already settle-able (a receipt arrived, or the TTL
  passed) before refusing (ADR 0037);
- the external job leaves an **immutable receipt** per request, with a stable
  `errorCode` (ADR 0041), and the Coordinator settles from that file;
- **success is proven by identity, never self-reported**: the server completes a
  request only when `computerVersion === daemonVersion === expectedVersion` and
  the `workerInstanceId` has changed (ADR 0030, ADR 0037);
- failure copy already maps every `UPGRADE_ERROR_CODE` to a headline and real
  commands, inline, never as a toast (ADR 0041, `docs/design.md` §13).

What is missing is not correctness of the machine protocol. It is that **the
browser, not the Computer, is where upgrade progress lives today**.

## Decision

**An upgrade in progress is a property of the Computer, and the browser renders
it. The browser never owns it.**

### 1. The Daemon reports its upgrade state on the channel it already has

The Workspace daemon already makes a repeating RPC every 30 s
(`DAEMON_CONNECTION_STATUS_METHOD`, `COMPUTER_STATUS_REFRESH_MS`, payload
`{ ...config, online: true }`) whose handler puts the `online` lease in Redis for
90 s (`computer-status.server.ts`). That payload gains one **additive optional
field**:

```jsonc
"upgrade": {
  "requestId": "95e10fe7-…",
  "targetVersion": "0.1.0-dev.75",
  "requestedAt": "2026-09-22T10:06:21Z",
  "phase": "restarting"        // optional; see §5
}
```

— or the field is absent when no operation is pending. The server caches it
beside `online` under the same lease, so a Computer that stops reporting
(including one restarting into a new version) stops claiming an in-progress
upgrade by itself, with no separate expiry to reason about.

### 2. The Computer row is the one place progress is shown

The row that already carries the Online dot and the Version field renders, while
that snapshot is present:

> **正在升级到 `0.1.0-dev.75`** · 已 1 分 20 秒  *(由 @someone 发起)*

with the Upgrade control disabled, and — for an upgrade the member started —
one toast line confirming the click was accepted. Nothing else changes: no
second progress indicator, no duplicate copy (§5: "每个事实只出现一次").

`elapsed` is derived from the snapshot's `requestedAt` on the server clock, so
it keeps counting across reloads, across browsers, and for every member of the
Workspace, including one who opens the page after the click.

### 3. Waiting is not failing, and the browser has no vote

- A terminal state comes from the machine only: a receipt (`succeeded`/`failed`
  + `errorCode`), or the machine's own TTL expiring the operation
  (`UPGRADE_EXPIRED_WITHOUT_RECEIPT`).
- The Redis request record stays what it is: **dedupe and attribution** for one
  click, with its own TTL. It is no longer rendered as the upgrade's state, so
  its `timeout`/`evidence` reasons become unreachable in the normal path rather
  than being the thing a member reads while a job is running.
- A refusal that means "already running" is **not a failure state at all**: the
  request is answered 202 with the operation already in progress, and the row
  shows the same in-progress line the snapshot would have produced. To make that
  structural rather than a copy decision, `UpgradeState`
  (`none | in_progress | succeeded | failed`) is a separate type from the failure
  copy table, and `UPGRADE_OPERATION_PENDING` moves out of `CODE_COPY` — the
  failure table can no longer reach it.
- The failure copy table keeps every code that *is* a failure, unchanged.

### 4. Success stays where it is

The row flips to the new version when the server observes the new identity
(ADR 0030), which is also when the in-progress snapshot stops being reported. A
reported success alone still completes nothing.

### 5. Phases are additive, coarse, and optional

The job knows where it is; a member does not need to. The snapshot may carry a
`phase` (`downloading` → `verifying` → `installing` → `switching` →
`restarting`), written by the upgrade job into its own receipt file so it
survives the job's own process being replaced. Until that exists, the row shows
"正在应用升级" plus elapsed time — an honest coarse state, never an
indeterminate spinner with no sense of whether anything is happening.

## Rejected alternatives

- **Longer or smarter polling in the browser.** Raising the window (the stopgap
  in #648) removes one misreport but keeps the state in a component, so a
  reload, a second browser, or a member who arrives mid-upgrade still sees
  nothing, and any new window is still a guess about how long an upgrade takes.
- **A second `UPGRADE_IN_PROGRESS` code beside `UPGRADE_OPERATION_PENDING`.**
  ADR 0041 already rejected splitting them: the Coordinator cannot probe whether
  the job behind a pending slot is alive or orphaned, only whether a receipt or
  the TTL arrived, so the second code would not correspond to a distinction this
  system can make.
- **Making the click's request record the source of truth.** It exists only if
  this browser's click reached the server, expires on its own 10-minute TTL, and
  knows nothing about a job started by the CLI or by crash recovery.
- **A per-browser realtime subscription just for upgrades.** The status lease
  already carries the fact we need and already renews every 30 s; a second
  channel would be a second thing to keep consistent.
- **Doing nothing but rewording the failure.** The headline was only the most
  visible half; leaving the state with the click leaves items 1 and 3 above in
  place.

## Consequences

- `docs/design.md` §13's "navigation away and back must still find it"
  becomes true for upgrades, and its "no two presentations of the same fact"
  rule stays true because the row, not a toast, carries the state.
- The refusal path stops being user-visible in normal operation; a member who
  clicks Upgrade twice gets the same row state and no error.
- Protocol change is additive: an older daemon sends no `upgrade` field, and the
  row degrades to today's click-owned behaviour. That degradation must never
  produce a *wrong* state — a Computer whose daemon does not report has no
  in-progress line, which is today's behaviour, not a claim that it is idle.
- `#648` (copy + a 3-minute upgrade window) remains worth landing on its own as
  the smallest fix for the misreport; §2 supersedes its window once the row owns
  the state, and nothing in it conflicts.

## Migration plan

1. **Land #648** — honest copy for a running operation, and a window that fits a
   real upgrade. Independent of everything below.
2. **Carry the snapshot**: additive `upgrade` on the status payload; daemon
   builds it from the Coordinator's pending-operation snapshot (the same one
   `coforge-computer status` already prints as `unsettled upgrade: …`); server
   caches it with the online lease; the Computer row payload exposes it.
   Tests: cache round-trip, absent field, lease expiry.
3. **Render it**: in-progress line with elapsed time and a disabled control,
   derived from the row payload; delete the upgrade poll loop as a state owner;
   move `UPGRADE_OPERATION_PENDING` out of the failure table. Tests: the row
   renders in-progress from a snapshot alone (no click, no poll); a refusal
   renders as in-progress; leaving and returning still shows it.
4. **Optional phases**, once the row is the source of truth.

## Validation and rollback criteria

- On a real Computer: start an upgrade, then in a second browser, and after a
  full reload, confirm the row shows the same target version and a growing
  elapsed time; confirm the Upgrade control is disabled; confirm a second click
  in the first browser changes nothing on screen.
- Confirm the row clears and the Version field updates only when the new
  identity is observed, and that a failed operation still renders its
  `errorCode` copy inline.
- Rollback: the render path is additive — ignoring the snapshot restores
  click-owned behaviour with no protocol change to undo.
