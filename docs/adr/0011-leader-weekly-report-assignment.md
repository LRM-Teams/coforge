# ADR 0011: Leader weekly-report assignment and submission visibility

Status: accepted
Date: 2026-09-14
Supersedes: parts of [ADR 0009](0009-workspace-records-weekly-reports.md) (template-row child create via “+”, and the standing rejection of Records→Message delivery)

## Context

Workspace Records needs a Leader→member weekly-report loop, not only free-form
document trees. Leaders configure send rules, publish a formatted weekly parent
under「成员周报」, and collect member-filled returns. Early UI allowed Leaders to
create child pages with “+” for development convenience; that no longer matches
the product.

## Decision

1. **Leader weekly parent**: Each scheduled or manual send creates a **new**
   template-kind `WeeklyReport` parent under「成员周报」for that week (format /
   outline owned by the Leader).
2. **Assignment title**: The member-facing document title is
   `{memberDisplayName}的周报 · W{week}` (member’s name + week number).
3. **Member inbox**: On send, each recipient gets a node under「我的周报」with an
   unread-style highlight until first open; after submit it shows an「已发送」
   marker and may be resent, **overwriting** the same submission for that
   `(parent, member)` pair in the same week.
4. **Child visibility**: Submissions appear under the Leader parent (sidebar and
   overview) **only after** the member has submitted (`submitted` / `shared`).
   Leaders do **not** pre-create children via “+”. After submit, the member can
   also see their own submission under that parent in「成员周报」.
5. **Delivery**: After a successful Leader send, Web/backend posts **one**
   best-effort message to Workspace `#general` as the Leader (body names the
   sender and week; members still use「我的周报」as the inbox). Channel failure
   must not roll back assignments. Dedicated DM or alternate channels remain
   follow-ups.
6. **Send settings**: Exactly zero or one `WeeklyReportTemplate` may be
   `applied`. Leader「发送给成员」requires an applied row; with none applied the
   button is disabled. `scheduleEnabled` (edited in the template dialog) permits
   periodic send when also applied. `sendWeekday` is ISO 1–7 (default Friday)
   with `sendTime`; due clock is `Asia/Shanghai`. Cron calls
   `POST /api/internal/weekly-report-schedule` with
   `x-coforge-weekly-report-cron-secret`.

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
- New child row on every resend: rejected; one submission per member per parent,
  overwritten on resend.
- Title based on Leader or template name only: rejected; product requires the
  member’s display name plus week.

## Consequences

- `createTemplateChildReport` / sidebar “+” are removed from the product path;
  assignment creation moves to a later send use case.
- Catalog and parent overview filter children to submitted/shared.
- Assignment unread state lives in `content.assignment.unread` until a dedicated
  column is approved; opening an assignment clears unread; submit/resubmit sets
  `submitted` on the same row (overwrite).
- Schema or Message integration for schedule/delivery may need Frank’s gate when
  those slices add columns or wire protocol. This slice adds `applied`,
  `scheduleEnabled`, and `sendWeekday` on `WeeklyReportTemplate`, plus an
  internal cron HTTP route (not a durable job system).
