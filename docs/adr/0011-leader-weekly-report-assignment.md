# ADR 0011: Leader weekly-report assignment and submission visibility

Status: accepted
Date: 2026-09-14
Supersedes: parts of [ADR 0009](0009-workspace-records-weekly-reports.md) (template-row child create via “+”, and the standing rejection of Records→Message delivery)

## Context

Workspace Records needs a Leader→member weekly-report loop, not only free-form
document trees. Leaders configure send rules, publish a formatted weekly parent
under「成员周报」, and collect member-filled returns. Early UI allowed Leaders to
create child pages with “+”, sibling template parents from「成员周报 +」, and
personal drafts from「我的周报 +」for development convenience; that no longer
matches the product.

## Decision

1. **Leader weekly parent**: Each scheduled or manual send creates a **new**
   template-kind `WeeklyReport` parent under「成员周报」for that week (format /
   outline owned by the Leader). Catalog listing and send settings are **per
   User**, not Workspace-shared: each Leader only sees and manages their own
   format chip, sent-week overviews, and `WeeklyReportTemplate` rows.
2. **Assignment title**: The member-facing document title is
   `{memberDisplayName} {year} W{week} 工作周报` (see
   [ADR 0015](0015-member-week-sidebar-share-export.md)).
3. **Member inbox**: On send, each recipient gets a node under「我的周报」with an
   unread-style highlight until first open; after submit it shows an「已发送」
   marker and may be resent, **overwriting** the same submission for that
   `(parent, member)` pair in the same week.
4. **Child visibility**: Submissions appear under the Leader parent (sidebar and
   overview) **only after** the member has submitted (`submitted` / `shared`).
   Leaders do **not** pre-create children via “+”. After submit, the member can
   open that parent and see **only their own** submission; other Leaders’ trees
   stay private. Direct subject reads allow the assignment author or the parent
   template author; unrelated Workspace members get not-found. Leader review of
   a submission is read-only: the body cannot be edited, and send/delete stay
   with the author.
5. **Delivery**: After a successful Leader send, Web/backend posts **one**
   best-effort message to Workspace `#general` as the Leader (body names the
   sender and week; members still use「我的周报」as the inbox). Channel failure
   must not roll back assignments. Dedicated DM or alternate channels remain
   follow-ups. Channel notice wiring is best-effort and is skipped when
   Centrifugo is not configured; missing realtime config must not block send.
6. **Send settings**: A User may have **zero or more** `WeeklyReportTemplate`
   rows `applied` within a Workspace (no longer limited to one). Each applied
   row is an independent send stream: its own recipients, schedule, outline,
   live format document, and top-chip button (label = settings `name`). Leader
   「发送给成员」and chip arming are evaluated **per stream** (that row’s
   weekday/time/`scheduleEnabled`, and whether **that** stream already sent in
   the current ISO week). Preview-hour arming and edit-cancels-auto-send are in
   [ADR 0012](0012-weekly-report-preview-auto-send.md). With no applied rows, one gray non-interactive chip
   still renders for the current week. Format/overview `WeeklyReport` rows that
   belong to a stream store `settingsId`. Cron still calls
   `POST /api/internal/weekly-report-schedule` with
   `x-coforge-weekly-report-cron-secret`, and runs each due applied+scheduled
   row as its `ownerId` against that row’s format.

## Slice plan (implementation order)

1. Remove Leader “+” child create; list/overview only show submitted children.
2. Unread highlight,「已发送」, open-clears-unread, resend overwrite.
3. Leader **manual** send: new weekly parent + member assignments from the latest
   `WeeklyReportTemplate` recipients.
4. Wire `#general` channel notice after manual send.
5. Scheduled send: dialog-owned `scheduleEnabled` + `sendWeekday`; cron route
   reuses `sendWeeklyAssignments` with per-cycle idempotency.

## Rejected alternatives

- Keep “+” to seed draft children for Leaders: rejected; hides the real
  assignment lifecycle and confuses empty vs submitted state.
- Keep「成员周报 +」to add sibling template parents by hand: rejected; parents
  come from Leader send only.
- Keep「我的周报 +」to add personal drafts by hand: rejected; the inbox is
  assignments from send.
- New child row on every resend: rejected; one submission per member per parent,
  overwritten on resend.
- Title based on Leader or template name only: rejected; product requires the
  member’s display name plus week.

## Consequences

- `createTemplateChildReport` / template-row “+”, `createTemplateReport` /
  「成员周报 +」, and `createMemberReport` / 「我的周报 +」are removed from the
  product path; parents and assignments are created by send.
- Catalog and parent overview filter children to submitted/shared.
- Leader review of a submitted assignment is read-only; only the author may
  edit, send, or delete that document.
- Assignment unread state lives in `content.assignment.unread` until a dedicated
  column is approved; opening an assignment clears unread; submit/resubmit sets
  `submitted` on the same row (overwrite).
- Schema or Message integration for schedule/delivery may need Frank’s gate when
  those slices add columns or wire protocol. This slice adds `applied`,
  `scheduleEnabled`, `sendWeekday`, per-user `ownerId`, and multi-applied
  streams linked via `WeeklyReport.settingsId`, plus an internal cron HTTP
  route (not a durable job system). Send settings, format templates, and
  「成员周报」trees are private to each User within a Workspace. Multiple
  applied settings rows each own a top chip and send state machine.
