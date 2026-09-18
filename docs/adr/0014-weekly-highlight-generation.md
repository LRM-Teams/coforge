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

- Team / cycle-level key-point document generation and sidebar「周报要点」nodes.
- Restoring `WeeklyReportHighlight` table or rule extractors.
- New Prisma models/columns for prompts or extraction.

## Rejected alternatives

- Rule / heuristic extraction on member Markdown: rejected; product requires LLM.
- Running the member’s own weekly-report assistant: rejected; Leader owns prompts
  and review UX.
- Requiring Leader to open the side chat to receive results: rejected; prefer
  HTTPS write-back so results land while Leader is offline.
- Calling Workspace Agent runtimes from ad-hoc Web paths outside the weekly-report
  assistant seams: rejected; keep Daemon skill + authorized Agent HTTPS.

## Consequences

- Catalog: `startPersonalKeyPointExtraction` / `applyPersonalKeyPointExtraction`;
  submit hook in `saveReportContent`.
- Daemon skill `weekly-report` wakes on `[weekly-report-key-points]` and submits
  via CLI/HTTPS.
- Settings edit both team and personal prompts; only **personal** auto-runs after
  member submit in this slice.
