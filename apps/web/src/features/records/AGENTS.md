# Records (weekly reports)

These rules also cover `src/server/records/`.

- Workspace Records (weekly reports) belong to `features/records/` (list/detail,
  settings, stats, side comments, and Server Functions) and
  `server/records/record-catalog.server.ts` (cycles, reports,
  templates, favorites, notes, and comments). Persistence is Prisma under
  Workspace membership. Report bodies use lightweight outline JSON keyed by
  template-dimension tabs. Side panels retain platform comments and Collect cards alongside the private
  assistant conversation.
  The weekly-report assistant's on-demand reads reuse `RecordCatalog` through
  Agent HTTPS `POST /api/agent/v1/weekly-reports`, authorized as the assistant owner User.
  Multi-Computer collect belongs to
  `server/records/weekly-report-collector.server.ts` (per-Computer Collector
  bindings) and `server/records/weekly-report-collect-run.server.ts` (narrow
  Collect Run ledger). Pack submit and side-panel cards are follow-up seams;
  do not add WSS collect-result RPCs. Schema merge requires Frank approval.
- Sidebar expand state: `records-sidebar-expand.ts` owns sessionStorage recall
  for the last entry section (`activeSection`) and week openness; remount opens
  only that section (not every list that contains the selected report). Cold
  start without an entry prefers mine → members → favorites. Do not default
  every CollapsibleSection to open.
- Do not nest `ModalOverlay` under React Aria `Tabs`. Tabs' CollectionBuilder
  remounts children in a Hidden tree; ModalOverlay is not hideable, so an open
  dialog mounts twice and `ariaHideOutside` makes the visible one inert.
  Render settings dialogs as siblings outside `Tabs` (see `weekly-report-settings.tsx`).
- 「取消本周周报」and schedule-tick skip keys use the current ISO week
  (`currentIsoWeek(zonedCalendarDate(now))`), not the live format document's
  possibly stale `cycle`. Stamp dismiss with that calendar week.
- Format offer-send (发送 / 取消本周周报) is posted once per report for the
  current ISO week into the session that loads first. Earlier weeks' cards stay
  in that thread as history. Do not fan the current week's card out to every
  new or idle side-panel session (`hasCurrentWeekOfferSend`). Other sessions
  stay empty — do not stuff a ready/cancelled tip into them.
- Side-chat greetings (hi / 你好 / …) are not platform rule replies; route them
  through the weekly-report Agent like ordinary turns.
- Live format documents rebase onto the current ISO week when reused or when
  posting the offer-send card; do not keep showing the creation-week cycle after
  the calendar advances (see `rebaseLiveFormatToCurrentWeek`).
- Present mode shows one template-dimension page at a time and zooms images in
  place. It does not rewrite report JSON. Use a full-bleed portal
  (`report-present-mode.tsx`); `ModalOverlay` is padded and is not full-bleed.
- After a member sends, further edits stay on the working body. Recipients
  (Leader report, dashboard summary, PPT) keep the last sent copy in
  `content.delivered` until the author sends again. Do not add a column for
  this snapshot.

- `server/records/weekly-report-workflow.server.ts` owns owner-scoped DM actions
  (discover, configure, send, save, submit, summarize); `weekly-report-distribution.server.ts`
  owns atomic per-settings/per-week distribution, and `weekly-report-notification.server.ts`
  posts invitations in the recipient's own assistant DM. Agent operations reuse
  the existing HTTPS weekly-reports endpoint; no generic job or mailbox is added.
- The Records tools menu has dashboard, stats and settings; the private assistant
  DM is the conversational entry point. Do not restore a duplicate assistant page.
- Agent template discovery does not require a cycle or submitted member reports.
  DM and page-scoped explicit requests use the same workflow operations. Do not
  intercept send or summarize phrases with side-panel keyword rules. Previews
  and Collect handoffs retain Insert; legacy pending cards must stay usable.
- Template discovery shares the workspace format catalog across DM/page context;
  only owner entries expose delivery settings and can be configured or sent.
  Other entries are reusable outlines, not grants to another owner's settings.
