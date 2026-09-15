# ADR 0013: Weekly highlight prompt (要点模板) and dual-send wording

Status: accepted
Date: 2026-09-15
Amends: [ADR 0009](0009-workspace-records-weekly-reports.md) (highlights vs send templates)

Design T4/T5 split **要点模板** (Leader’s extraction prompt + history) from
`WeeklyHighlight` (the generated result document). Sending from the format page
confirms both the weekly outline template and this prompt.

## Decision

1. **Prompt ownership**: The live format `WeeklyReport` (template kind, no
   assignments, linked by `settingsId`) stores the working prompt on
   `content.highlightPrompt`: `{ text, updatedAt?, history: [{ text, updatedAt }] }`.
   No new Prisma column in this slice (same JSON-meta pattern as assignment
   unread and auto-send cancel). `WeeklyHighlight` remains the result document
   only.
2. **History**: Saving a non-empty prompt that differs from the previous `text`
   pushes the previous text onto `history` (newest first, capped), stamped with
   that version’s prior `updatedAt` when known.「重新启用」 copies a history
   entry into the editor; the next save can create another history row if the
   Leader changes it again.
3. **Carry-forward**: `ensureFormatForSettings` copies `highlightPrompt` from the
   previous live format of the same settings stream when creating a new format.
4. **Dual send**: Leader send still creates weekly assignments only. The confirm
   dialog states that members receive the weekly template and that later
   highlight extraction will use the latest saved prompt. No separate member
   assignment is created for the prompt. Actual AI generation stays WR-40+.
5. **Settings 要点模板 table**: Still deferred; Leaders edit the prompt on the
   format page’s「要点模板」tab.

## Rejected alternatives

- New `WeeklyHighlightTemplate` table / columns on `WeeklyReportTemplate`:
  deferred until a schema gate needs shared settings-row CRUD (T7 table).
- Sending the prompt text to members as a document: rejected; design only sends
  the weekly template to the recipient list.

## Consequences

- Format `getSubject` exposes `highlightPrompt` for the format surface.
- Confirm-dialog copy mentions both templates; delivery path unchanged.
