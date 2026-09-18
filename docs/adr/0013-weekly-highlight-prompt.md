# ADR 0013: Weekly key-point prompts (要点提示词模板)

Status: accepted
Date: 2026-09-15
Updated: 2026-09-18
Amends: [ADR 0009](0009-workspace-records-weekly-reports.md) (highlights vs send templates)

Design T4/T7: Leaders edit **team** and **personal** extraction prompts (with
history「重新启用」) from Records settings, stored on the live format document.
Personal prompts drive automatic member-report extraction ([ADR 0014](0014-weekly-highlight-generation.md)).

## Decision

1. **Prompt ownership**: The live format `WeeklyReport` (`kind=template`, no
   member assignments, linked by `settingsId`) stores prompts on
   `content.keyPointPrompts`: `{ team, personal }`, each shaped like
   `{ text, updatedAt?, history: [{ text, updatedAt }] }`. No new Prisma column
   (same JSON-meta pattern as assignment unread and auto-send cancel).
2. **Settings UI**: Records settings top tabs are「周报模板 | 要点提示词模板」;
   the key-point tab further splits「全员 | 个人」. Both slots are editable and
   keep history. Editing on the format page「要点模板」tab is no longer the
   product path.
3. **History**: Saving a non-empty prompt that differs from the previous `text`
   pushes the previous text onto `history` (newest first, capped), stamped with
   that version’s prior `updatedAt` when known.「重新启用」copies a history
   entry into the editor; the next save can create another history row if the
   Leader changes it again.
4. **Persistence across weeks**: The live format document for a settings stream is
   reused when present (`ensureFormatForSettings`), so `keyPointPrompts` persist
   without a separate copy step when the same live format remains.
5. **Dual send**: Leader send still creates weekly assignments only. Confirm
   dialog may still mention that later extraction uses the latest saved prompts.
   No separate member assignment is created for the prompt.
6. **Catalog seams**: `loadKeyPointPrompts` / `saveKeyPointPrompts` resolve the
   newest applied (else newest owned) settings stream and its live format.

## Rejected alternatives

- New `WeeklyHighlightTemplate` table / columns on `WeeklyReportTemplate`:
  deferred until a schema gate needs shared settings-row CRUD.
- Sending the prompt text to members as a document: rejected; design only sends
  the weekly template to the recipient list.
- Keeping `content.highlightPrompt` as the sole prompt field: superseded by
  `keyPointPrompts.team` / `keyPointPrompts.personal`. Legacy `highlightPrompt`
  is dropped on normalize.

## Consequences

- Format `getSubject` no longer depends on a single `highlightPrompt` for the
  settings surface; settings load prompts via `loadKeyPointPrompts`.
- Confirm-dialog copy may still mention both templates; delivery path unchanged.
- Automatic personal extraction uses `keyPointPrompts.personal` (ADR 0014).
