# ADR 0012: Weekly-report preview hour and edit-cancels auto-send

Status: accepted
Date: 2026-09-15
Amends: [ADR 0011](0011-leader-weekly-report-assignment.md) scheduled-send arming (decision 6)

Design (T1–T3) pushes the live format to the Leader one hour before `sendTime`,
counts down to auto-send, and cancels that auto-send if the Leader edits the
format. ADR 0011 armed the chip for the whole send weekday and let cron send at
`sendTime` even after an edit.

## Decision

1. **Preview window**: For an applied + `scheduleEnabled` stream, the chip
   highlights and counts down during `[sendTime − 1h, sendTime)` on
   `sendWeekday` (Asia/Shanghai). The Leader may send manually in that hour.
   After `sendTime`, the countdown ends; the chip stays clickable until
   midnight if this ISO week is not yet sent.
2. **Auto-send**: Cron still fires when local clock is `>= sendTime` on
   `sendWeekday`, once per stream per ISO week. If the Leader **changed the
   live format body** at or after the preview start, cron **skips** that week
   (`auto-send-cancelled`); the Leader must send manually.
3. **Cancel flag**: Stored on the format document as
   `content.schedule.cancelledYear` / `cancelledWeek` (same JSON-meta pattern
   as assignment unread). No new Prisma column. Opening the format without a
   body change does not cancel. Edits before the preview window do not cancel.
   After WR-13 the live format page only persists on explicit「保存」(or the
   send path’s pre-send persist); cancel is written on that server save when
   the body changed inside the preview window—not on every keystroke.
4. **Nav attention**: The Records rail item shows a dot while any of the
   viewer’s streams is in the preview window and not yet sent and not
   cancelled, **or** while the viewer still has an unread Leader assignment
   under「我的周报」(cleared when the assignment is opened). Not a Message
   unread.
5. **Out of scope here**: Assistant side-chat copy, in-chat send, and dual
   highlight-template send (WR-09/10/22/23).

## Rejected alternatives

- Treat any `updatedAt` bump as an edit: rejected; `ensureFormat` and title
  sync would cancel auto-send without a Leader edit.
- New `WeeklyReport` column for cancel: rejected until a schema gate needs it;
  JSON meta matches assignment unread.
- Keep all-day Friday arming: rejected; the design countdown is one hour.

## Consequences

- `isWeeklySendArmed` for scheduled streams is the one-hour preview, not the
  civil send day. Manual send after cancel still uses the send-day remainder.
- Cron skip reason `auto-send-cancelled` is idempotent with `already-sent`.
