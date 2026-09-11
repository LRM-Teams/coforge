# ADR 0009: Workspace Records (weekly reports)

Status: proposed (schema gate — needs Frank approval before merge to main)
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
   Cycles are created on demand when a highlight, personal member report, or
   cycle template report is added for the current ISO week. Highlight create,
   “我的周报” create, and “成员周报” create remain independent UI actions.
2. **WeeklyReport** has `kind` `member` | `template`.
   - `member`: personal reports listed under “我的周报”. Multiple per
     `(cycle, author)` and duplicate titles are allowed.
   - `template`: listed as flat top-level nodes under “成员周报”. Clicking a
     template opens its editor. Creating via “成员周报 +” adds a **sibling**
     template node (default title like `2026 W37 工作周报`). Titles may
     duplicate (Multica Notes-style); identity and navigation use the report
     UUID. Templates are **not** listed under “我的周报”.
   - **Submissions / child pages**: member reports with `sourceTemplateId`
     appear as **children** of that template node (any status, including draft).
     Creating via the row “+” after the actions menu adds a child under that
     template (copies the template body, uses the template’s cycle). Opening a
     template shows an overview table of children; the **name** column is bound
     to each child’s author display name (other columns deferred).
   Body is `content` JSON `{ markdown: string }` — one TipTap Markdown document
   (Notes-style), not tabs/sections. Draft opening does not realign body
   structure from send templates. Legacy tab/section / outline JSON is
   flattened to Markdown on read. Creating either kind does **not** create the
   other, nor a highlight.
3. **WeeklyReportTemplate** is Workspace-level **send** configuration (name,
   frequency, time, recipients). `dimensions` / `mainTitles` may still be
   stored for settings UI compatibility but do **not** drive report body
   structure.
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
  wants a single Markdown document like Multica Notes.
- Storing report body outside JSON (plain text column): deferred; Json keeps
  migration of legacy shapes without a schema rewrite.
- Coupling templates to Message/Task: rejected; Records is not chat delivery.
- Embedding Centrifugo for report comments in MVP: deferred; HTTPS server
  functions are enough until live co-editing is required.

## Consequences

- Additive Prisma migration under `apps/web/prisma/migrations`.
- Domain ownership: `src/server/records/*`; browser seam: `src/features/records/*`.
- Demo catalogs must not ship; empty Workspace shows empty sections until users
  create cycles/templates/reports.
- `WeeklyReport` no longer enforces uniqueness on `(cycleId, authorId, kind)`;
  member and template reports may share titles within a cycle.
- Member submissions may set optional `sourceTemplateId` to hang under a
  template node in “成员周报”.
- Merge to `main` requires Frank’s schema approval per AGENTS.md decision gates.
