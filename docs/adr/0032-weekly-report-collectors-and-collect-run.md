# ADR 0032: Weekly-report collectors and Collect Run

Status: **accepted**
Date: 2026-09-17

Amends: [ADR 0009](0009-workspace-records-weekly-reports.md) (member report
body authorship remains User-owned; this ADR adds an OS-harvest path into
confirmed assistant suggestions), [ADR 0011](0011-leader-weekly-report-assignment.md)
(assignment / send unchanged), and the weekly-report assistant product
decisions in
[`docs/implementation-slices/weekly-report-ai-requirements.md`](../implementation-slices/weekly-report-ai-requirements.md)
(assistant still must not auto-send).

Product contract:
[`docs/implementation-slices/weekly-report-collect-requirements.md`](../implementation-slices/weekly-report-collect-requirements.md)

Ballot: D1–D9 locked to the recommended ★ options on 2026-09-17 (requester
accepted the implementation-slice defaults). Prisma migration that introduces
Collect Run tables still lands only through the normal Frank-gated schema CR.

Reference (not adopted wholesale): Multica ADR 0019 / Notes Period Work Brief
(`period-collect-*` collectors, plan card, settle, partial harvest, one platform
retry). CoForge maps the same *split* onto Records + Daemon + existing
WeeklyReportAssistant — not Notes FAB / Note Worker / `~/.multica`.

## Context

Employee design boards (`front/员工 收到模板_1.png`, `front/员工 收到模板_2.png`)
and product intent require:

1. After a Leader template assignment, the side-panel WeeklyReportAssistant
   offers to generate the member report.
2. Generation needs **detailed work evidence from the User's Computers**
   (office / server machines), harvested by Agents that run **on those
   machines**.
3. The User configures missing collectors, picks which Computers and scan
   paths participate, then confirms. Collectors run in parallel.
4. The assistant (and platform) observe per-Computer completion / failure,
   then synthesize into the boss template and paste into the member report
   via the existing confirmation-backed suggestion flow.
5. Send remains a User decision (button or assistant send-prompt).

Today CoForge already has: one WeeklyReportAssistant per User×Workspace,
skill pack `weekly-report`, Agent HTTPS weekly-report reads, confirmation
body/highlight writes, and User-controlled send. It does **not** have:
per-Computer collector Agents, scan-path configuration, a collect run
ledger, pack submission, or multi-Computer settle.

`docs/architecture.md` rejects making generic jobs / workflows / durable
command mailboxes part of the core model without a recorded decision. A
**narrow** Collect Run scoped to weekly-report harvest is therefore an
explicit exception recorded here, not a general task engine.

## Decision

Locked ballot (see product contract §7): **D1A, D2A, D3A, D4A, D5A, D6A,
D7A, D8A, D9A**.

### 1. Split collect vs synthesize (D1A, D9A)

- **WeeklyReportCollector** — one dedicated Agent **per Computer the User
  owns**, bound to that Computer only. Display name pattern
  `采集 · <computer label>` (exact slug convention at implementation).
  Never harvest another member's Computer. Same hide-from-Members pattern
  as WeeklyReportAssistant.
- **WeeklyReportAssistant** — remains the synthesizer and side-chat voice.
  It reads settled packs + template structure, speaks progress, emits
  `[weekly-report-suggestion]`, and may prompt send. It does **not** choose
  window / Computers / roots, does not call start, and does not walk any OS.

### 2. Human owns scope; platform owns ACL and scheduling (D2A, D3A)

- Intent soft-confirm or exact 「需要」 opens platform-owned UI cards in the
  Records side panel (design boards), not chat XML fences.
- **Collector setup card** when any owned Computer lacks a collector (or the
  collector is unusable). Missing slots are optional to fill; the User may
  continue with the Computers that are ready.
- **Collect plan card**: time window (week / month / quarter / year /
  custom) + multi-select owned Computers + per-Computer scan paths + gear
  to reopen Agent create/configure dialog + Submit.
- Submit starts the Collect Run. The assistant may narrate; it must not be
  the authorization boundary for start.

### 3. Narrow Collect Run ledger (D5A) — not a generic job system

Introduce a Records-owned **WeeklyReportCollectRun** (names final in the
schema CR) persisted in PostgreSQL:

- Linked to the target member `WeeklyReport` and the User who started it.
- `status`: `awaiting_intent` | `missing_collectors` | `clarifying` |
  `collecting` | `synthesizing` | `awaiting_confirm` | `ready_to_send` |
  `done` | `cancelled` (exact enum may collapse unused UI-only states into
  session/prompt rows — see contract).
- Per-Computer collector slots: `computerId`, `agentId`, slot `status`
  (`running` | `ready` | `failed` | `empty` | `stalled` | `cancelled`),
  `retryCount`, error summary, `packMarkdown` (or object-store key for large
  packs), correlation id for the wake that produced the pack.
- Platform settle: wait for real terminal slot states; safety ceiling
  **15 minutes per wave**; at most **one** automatic platform retry per
  retryable slot (D7A); permanent config/auth failures are not retried.
- **Partial success still synthesizes** when ≥1 slot is `ready`. Synthesis
  is blocked only when no usable pack remains.
- This ledger is **weekly-report-collect only**. Do not generalize it into
  Workspace workflows, claim/lease mailboxes, or Daemon durable outboxes.

### 4. Scan roots (D4A)

- Authoritative list lives **on the Computer** (Daemon-local file under the
  CoForge computer data dir; exact path chosen at implementation).
- Empty / missing → heuristic `SCAN_ROOTS` (port Multica collect-recipes
  intent: first-level project parents, never deep `$HOME` / AppData /
  Library; denylist; strict `$START`/`$END` window).
- Non-empty list **replaces** the heuristic for that Computer.
- Cloud may cache a display copy for the plan card; live edit goes through
  an authorized Computer/Daemon path so the running collector sees the same
  file.

### 5. Pack submission and failure reporting (D6A)

- Collectors submit packs and terminal failures over **Agent HTTPS** (same
  family as `POST /api/agent/v1/weekly-reports`), with stable request ids and
  owner-User authorization — not via best-effort Agent Activity, and not via
  a new WSS business RPC.
- `agent:deliver` ACK still means attention accepted, **not** collect
  finished. Completion is only the HTTPS pack / failure report (or stalled
  timeout).

### 6. Synthesis and paste (D8A)

- After slots are final (or the User abandons remaining retries), platform
  wakes the WeeklyReportAssistant synthesizer turn with: template outline,
  ready packs, status board (which Computers failed).
- Output uses the existing confirmation envelope
  (`[weekly-report-suggestion]`) to propose body edits into the open member
  report. MVP tables = Markdown tables; diagrams = Mermaid in Markdown.
  Raster chart generation is a later slice.
- User Confirm writes; assistant reminds the User to review.

### 7. Send

- Unchanged product rule: assistant must not auto-send. User clicks send or
  asks the assistant to open the existing send confirmation / send-prompt
  path.

### 8. Provisioning policy

- Do **not** silently create collectors for every owned Computer on login.
- Setup card / plan card surfaces missing slots; User creates or repairs via
  the existing Agent create/configure dialog (Computer + runtime + model +
  credentials).
- Collectors are product-owned identities (stable naming), not ordinary
  Members-managed Agents the User invents ad hoc.

## Rejected alternatives

- **WeeklyReportAssistant alone walks every Computer remotely** — violates
  “Agent runs in its declared Agent workspace on one Computer”; no OS
  visibility on other machines.
- **Chat-only progress with no PG run** — cannot reliably settle parallel
  collectors; Agent Activity is best-effort and must not be the completion
  boundary.
- **Generic Workspace job / claim-lease / durable command mailbox** —
  architecture forbids expanding that surface without a broader decision;
  out of scope.
- **WSS RPC for pack upload** — Agent→Web business reads/writes already use
  HTTPS RPC; keep that seam.
- **Silent Ensure of all collectors** — Multica and this product both treat
  missing collectors as a human configuration step.
- **Assistant auto-send after paste** — rejected by weekly-report AI
  requirements.

## Consequences

- Prisma migration for Collect Run (+ optional collector binding table) is
  required before implementation slices that persist runs; that migration CR
  still follows the Frank schema gate.
- New Agent HTTPS routes for pack submit / collector failure (and
  collect-roots read/write documentation) are required.
- Daemon skill `weekly-report-collect` (or equivalent pack) installs on
  collector Agents; recipes adapted from Multica without copying Multica
  paths or Note Worker.
- Side-panel UI gains two platform cards (setup + plan) aligned to employee
  design boards; may extend Action Card patterns or Records-specific card
  parts — implementation choice, same human-commit spirit as ADR 0027.
- `docs/architecture.md` and `CONTEXT.md` record this decision.
- Does **not** change Leader assignment, cron send, or `#general`
  notification behavior.

## Validation

- Owner-only Computers appear on the plan card; foreign Computers never do.
- Missing collector → setup card; Submit with zero ready collectors is
  rejected.
- Parallel slots: one failure speaks immediately; one platform retry max;
  partial ready still synthesizes.
- Stalled after ceiling does not hang the run forever.
- Suggestion Confirm required before body write; send never automatic.
- `mise run test`, `check`, and `build` cover domain/API behavior; UI follows
  `docs/agents/testing.md` (manual).

## Rollback

- Feature-flag or omit UI entry (“需要”) so Users never start a Collect Run.
- Drop or ignore Collect Run rows; collector Agents can be archived.
- No wire-protocol version bump to daemon WSS control plane is required if
  packs stay on HTTPS only — rollback stays backend + skill + UI.

## Implementation details deferred to schema / code CRs

- Exact Prisma model and field names.
- Whether prompt/session states and Collect Run share one table or two.
- Collect-roots file path under the CoForge computer data dir.
- Whether large packs use FileStorage object keys instead of JSONB.
