# ADR 0014: Personal key-point extraction (LLM) and assistant side chat

Status: accepted
Date: 2026-09-15
Updated: 2026-09-18
Amends: [ADR 0009](0009-workspace-records-weekly-reports.md),
[ADR 0013](0013-weekly-highlight-prompt.md) (prompts used at generation time)

## Decision

### A. Personal key-point extraction (this product path)

1. **Trigger**: When a member report **first** enters `submitted` or `shared`,
   `RecordCatalog.saveReportContent` starts personal extraction for that report
   (idempotent: skip when `keyPointExtraction.status` is already `generating` or
   `ready`). Member submit itself must not fail if extraction fails.
2. **Who runs the assistant**: The **Leader** (source template / settings owner),
   via `WeeklyReportAssistant` + `platformTurn`. Not the submitting member’s
   assistant.
3. **Engine**: Weekly-report assistant **LLM** (skill + HTTPS write-back).
   Deterministic / rule-based highlight extraction and the removed
   `WeeklyReportHighlight` product path are **deprecated** for this flow.
4. **Persistence (no Prisma migrate)**: Result lives on the **member** report as
   `content.keyPointExtraction`:
   `{ status, promptSnapshot, markdown?, generatedAt?, error? }` with
   `status ∈ generating | ready | failed | pending_setup`.
5. **Prompt snapshot**: Uses Leader live-format `content.keyPointPrompts.personal`
   at start time (ADR 0013).
6. **Write-back**: Agent HTTPS `POST` personal key points (CLI
   `weekly-report-key-points submit`); do **not** use Confirm `body-edit`.
7. **UI**: Leader viewing a member report sees an injected trailing tab「要点提炼」
   (prompt strip + markdown result; generating / pending_setup / failed / ready).
   The member and non-Leaders do not see the tab.
8. **Assistant not ready**: If Leader assistant lacks Computer/Runtime,
   `status=pending_setup` (or `failed`); the tab shows setup guidance; submit
   still succeeds.

### B. Side chat (unchanged operational notes)

1. Browser still posts `authorType: user` comments; assistant rows are written by
   `RecordCatalog` on the server for format-page offers (preview / cancel-auto-send /
   offer-send).
2. Format page does **not** autosave outline edits (WR-13); only「保存」or send
   confirm’s pre-send persist writes the server. Member assignments and notes may
   still autosave.

### C. Out of scope for this slice

- Restoring `WeeklyReportHighlight` table or rule extractors.
- New Prisma models/columns for prompts or extraction.
- Sidebar「周报要点」nodes as a separate catalog entity (overview page hosts
  the team result in-place).

### D. Team / overview key-point extraction (added 2026-09-20)

1. **Trigger**: Leader clicks「整理全员要点」on the week overview page (manual;
   not auto on each member submit).
2. **Who runs**: Same Leader `WeeklyReportAssistant` + `platformTurn`.
3. **Prompt**: Live-format `content.keyPointPrompts.team` snapshot.
4. **Persistence**: Result on the **overview template** as
   `content.keyPointExtraction` (same meta shape as personal; overview parents
   are the only templates with member assignments).
5. **Write-back**: Same HTTPS `POST /api/agent/v1/weekly-report-key-points` /
   CLI `weekly-report-key-points submit`, with `reportId` = overview template
   id. Server dispatches by report `kind` (member → personal, template → team).
6. **Wake**: `[weekly-report-team-key-points]` lists submitted member report
   ids; skill instructs the assistant to read those reports and submit to the
   overview id.
7. **Overview table**: Lists **all** assignments (including draft). Submitted /
   shared names are links; draft names are plain. Submitted column shows 是/否;
   submit time shows locale time or `-`.
8. **Side-chat (re)organize**: When the Leader asks in the overview side chat
   (e.g. 「重新整理」), the product starts team extraction with
   `delivery: "side-chat-confirm"`. Agent HTTPS submit then parks markdown as
   `awaiting_confirm` and the server posts a `[weekly-report-suggestion]`
   `key-point-edit` bubble (preview + Insert). Confirm writes `ready` via
   `applyConfirmedKeyPointMarkdown`. The overview page button still uses direct
   `ready` write-back (no Insert step).

## Rejected alternatives

- Rule / heuristic extraction on member Markdown: rejected; product requires LLM.
- Running the member’s own weekly-report assistant: rejected; Leader owns prompts
  and review UX.
- Requiring Leader to open the side chat to receive results: rejected; prefer
  HTTPS write-back so results land while Leader is offline.
- Calling Workspace Agent runtimes from ad-hoc Web paths outside the weekly-report
  assistant seams: rejected; keep Daemon skill + authorized Agent HTTPS.
- Auto-running team extraction on every member submit: rejected; Leader chooses
  when the cohort is ready.

## Consequences

- Catalog: `startPersonalKeyPointExtraction` / `applyPersonalKeyPointExtraction`
  / `startTeamKeyPointExtraction` / `applyTeamKeyPointExtraction`; submit hook
  in `saveReportContent` for personal only.
- Daemon skill `weekly-report` wakes on `[weekly-report-key-points]` and
  `[weekly-report-team-key-points]`, submits via the same CLI/HTTPS; side-chat
  reorganize uses `key-point-edit` Confirm instead.
- Settings edit both team and personal prompts; personal auto-runs after member
  submit; team runs from the overview button or side-chat Insert.
