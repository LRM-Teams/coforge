# ADR 0009: Workspace Records (weekly reports)

Status: accepted (partially superseded by [ADR 0011](0011-leader-weekly-report-assignment.md) for Leader assignment / child visibility / Message delivery deferral)
Date: 2026-09-10

## Context

Product designs introduce a Workspace **Records** surface: weekly-report cycles,
member reports, highlights, favorites, reusable send templates, statistics, and
a side panel for human (and later assistant) comments. The previous UI used
hardcoded demo catalogs. Persistence must live in Web/backend PostgreSQL via
Prisma, scoped to Workspace membership.

AI drafting/side-chat replies are deferred; storage must still allow a future
`assistant` comment author without a schema rewrite.

## Decision

1. **WeeklyReportCycle** is the week bucket (`year` + `week`) in one Workspace.
   Cycles are created on demand when a highlight is added or Leader send
   creates a template parent for the current ISO week. Highlight create remains
   an independent UI action. Member reports under “我的周报” are assignments
   from send, not a sidebar “+” (see ADR 0011).
2. **WeeklyReport** has `kind` `member` | `template`.
   - `member`: listed under “我的周报” after Leader send. Multiple per
     `(cycle, author)` and duplicate titles are allowed.
   - `template`: listed as top-level nodes under “成员周报” **for the author only**
     (live format chip plus sent week overviews). Clicking the format chip opens
     the editor; clicking a week node opens the overview. Leader send adds a
     **sibling** parent for that week. Titles may duplicate (Multica Notes-style);
     identity and navigation use the report UUID. Templates are **not** listed
     under “我的周报”, and other Workspace members do not see another Leader’s
     format or overview tree in the catalog.
   - **Submissions / child pages**: member reports with `sourceTemplateId`
     appear as **children** of that template node **only after submit**
     (`submitted` | `shared`). Leaders do not pre-create children from the
     template row “+” (removed; see ADR 0011). Opening a template shows tabs:
     an overview table of submitted children (name column bound to each child’s
     author display name; other columns deferred) and a template editor.
     Creating a child via Leader send (later slice) copies the latest saved
     template body into the member assignment.
   Body is `content` JSON — TipTap Markdown / multi-page tabs as implemented.
   Draft opening does not realign body structure from send templates. Legacy
   tab/section / outline JSON is flattened to Markdown on read where needed.
   Creating either kind does **not** create the other, nor a highlight.
3. **WeeklyReportTemplate** is **per-User** send configuration within a Workspace
   (`ownerId`: name, frequency, time, recipients, and an outline of level-1 /
   level-2 headings stored in `dimensions` Json). Rows are not shared across
   Workspace members. **Multiple** rows may be `applied` at once for one owner;
   each applied row is a send stream with its own top chip and format document
   (`WeeklyReport.settingsId`). The outline drives that stream’s live format
   when the row is applied or updated while applied; edits to that format’s
   H1/H2 headings sync back into that settings outline. Legacy flat string
   `dimensions` arrays are still read as level-1-only sections.
4. **WeeklyReportFavorite** is per-User favorites of member reports.
5. **RecordComment** attaches to a subject (`report` | `highlight` | `cycle`) with
   `authorType` `user` | `system` | `assistant` and optional `payload` JSON for
   future assistant cards. MVP only writes `user` comments from the browser.
6. **RecordNote** is a personal Markdown note in the Records Notes tab. Body is
   plain Markdown text (same TipTap editor as weekly reports). MVP supports
   create / rename / edit / delete for the author's own notes; no tree, share,
   trash, or AI features yet.
7. Statistics are derived from cycles + report `status` (`draft` | `submitted` |
   `shared`), not a separate ledger.

## Rejected alternatives

- Tabbed sections driven by template dimensions/mainTitles: superseded — product
  wants Notes-style editing (single doc and/or explicit pages), not settings-driven
  section injection into the body.
- Storing report body outside JSON (plain text column): deferred; Json keeps
  migration of legacy shapes without a schema rewrite.
- Embedding Centrifugo for report comments in MVP: deferred; HTTPS server
  functions are enough until live co-editing is required.
- Permanently forbidding Records→Message delivery: **withdrawn** — that was only
  an early development deferral; see ADR 0011.

## Consequences

- Additive Prisma migration under `apps/web/prisma/migrations`.
- Domain ownership: `src/server/records/*`; browser seam: `src/features/records/*`.
- Demo catalogs must not ship; empty Workspace shows empty sections until users
  create cycles/templates/reports.
- `WeeklyReport` no longer enforces uniqueness on `(cycleId, authorId, kind)`;
  member and template reports may share titles within a cycle.
- Member submissions may set optional `sourceTemplateId` to hang under a
  template node in “成员周报” once submitted.
- Leader assignment / unread / resend / schedule behavior is governed by ADR 0011.
- Schema changes still require Frank’s approval per AGENTS.md decision gates.
