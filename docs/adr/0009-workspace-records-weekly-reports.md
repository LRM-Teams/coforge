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
   Creating a cycle (UI “+”) inserts the cycle and an empty **WeeklyReportHighlight**.
2. **WeeklyReport** is one document per `(cycle, author)` with `kind`
   `member` | `template`. Structured body is `content` JSON (tabs → sections →
   outline nodes). Tab labels come from the latest **WeeklyReportTemplate**
   `dimensions`; section titles come from that template's `mainTitles`. Draft
   reports realign tab keys to the latest template dimensions when opened.
   Report editing uses a lightweight outline editor (tabs → sections → nodes).
   A heavier BlockNote editor was evaluated and rejected for client latency.
3. **WeeklyReportTemplate** is Workspace-level send configuration (name,
   dimensions, titles, frequency, time, recipients). Recipients reference Users
   in the Workspace, or the sentinel `all` via a boolean `allMembers`.
4. **WeeklyReportFavorite** is per-User favorites of member reports.
5. **RecordComment** attaches to a subject (`report` | `highlight` | `cycle`) with
   `authorType` `user` | `system` | `assistant` and optional `payload` JSON for
   future assistant cards. MVP only writes `user` comments from the browser.
6. Notes tab remains a thin **RecordNote** table for later; empty in MVP UI.
7. Statistics are derived from cycles + report `status` (`draft` | `submitted` |
   `shared`), not a separate ledger.

## Rejected alternatives

- Storing report body as Markdown only: rejected; designs need nested outline
  editing and tabbed sections.
- Coupling templates to Message/Task: rejected; Records is not chat delivery.
- Embedding Centrifugo for report comments in MVP: deferred; HTTPS server
  functions are enough until live co-editing is required.

## Consequences

- Additive Prisma migration under `apps/web/prisma/migrations`.
- Domain ownership: `src/server/records/*`; browser seam: `src/features/records/*`.
- Demo catalogs must not ship; empty Workspace shows empty sections until users
  create cycles/templates/reports.
- Merge to `main` requires Frank’s schema approval per AGENTS.md decision gates.
