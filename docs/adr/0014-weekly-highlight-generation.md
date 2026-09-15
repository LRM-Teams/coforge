# ADR 0014: Assistant side chat and weekly highlight generation

Status: accepted
Date: 2026-09-15
Amends: [ADR 0009](0009-workspace-records-weekly-reports.md) (comments MVP-user-only;
highlight create as a standalone “+” action), [ADR 0013](0013-weekly-highlight-prompt.md)
(prompt used at generation time)

Design M3–M6: a Leader asks the Records side chat to generate this week’s
highlights from submitted member reports, optionally picking members. T2/T6:
the format page side chat is assistant-led (preview / cancel-auto-send /
send success), not a blank human comment thread.

## Decision

1. **Authors**: The browser still only posts `authorType: user` comments.
   Assistant (and system) rows are written by `RecordCatalog` on the server.
   `payload` JSON carries structured cards (`offer-generate`, `pick-members`,
   `offer-send`, `generating`, `generated`). Free-text assistant copy uses
   `body` only.
2. **Who may generate**: The viewer must own a `kind=template` report in that
   ISO-week cycle (the Leader who sent / formatted that week). Generation reads
   `submitted` | `shared` member assignments in the cycle. `memberIds: "all"`
   means every submitted author; an explicit list must be a subset of those
   authors.
3. **One highlight per cycle** (unchanged schema). Generation upserts
   `WeeklyReportHighlight` for the cycle. While running, `content.generating`
   is true and `completedAt` is null (sidebar「正在生成」, empty body). On
   success, `generating` is cleared, blocks are filled, `completedAt` is set.
   No new Prisma column.
4. **Extraction in this slice is deterministic**, not a cloud LLM. It uses the
   latest saved format `content.highlightPrompt.text` only as recorded context
   (not model input). Body comes from selected members’ Markdown: tabs whose
   titles look like 进展/本周/Summary →「一、本周进展」; 计划/plan →「二、下周计划」.
   Each item keeps `sources: [{ reportId, userId, displayName }]`. Clicking `@姓名`
   opens that member report. A later LLM adapter can replace the extractor
   without changing this catalog seam.
5. **Side-chat subjects stay the open document**. Offers and pickers attach to
   the member report (or format) the Leader is viewing. Completion comments
   also attach to the new highlight.
6. **Format page**: opening a live format auto-opens the side chat and seeds an
   assistant intro when the thread is empty (preview countdown, cancelled
   auto-send, or send-ready). Countdown renders next to the composer when the
   stream is armed. Human comments remain allowed.
7. **After explicit format save** (`askToSend`): if the edit newly cancelled
   auto-send, the catalog posts a cancel assistant message; otherwise if the
   Leader can still send this week, it posts `offer-send` asking whether to
   send. The live format page does **not** autosave outline or highlight-prompt
   edits (WR-13); only「保存」or the send confirm’s pre-send persist writes the
   server. Member assignments and notes may still autosave.

## Rejected alternatives

- New highlight/job tables or Prisma enums: deferred; JSON + existing
  `RecordComment.authorType` / `payload` is enough.
- Calling Workspace Agent runtimes from Web/backend: out of scope; would mix
  Records HTTPS with Daemon/ACP.
- Sending the prompt to members as a document: still rejected (ADR 0013).
- Asking to send after every keystroke: rejected; design T6 is after「保存」.
  Format-page autosave was removed (WR-13).

## Consequences

- `createHighlight` “empty draft +” remains for compatibility; product path is
  generate-from-side-chat.
- Catalog `highlights[]` exposes `generating` for the sidebar.
- Format `getSubject` may expose `sendSchedule` for the side-chat countdown.
- Browser Server Functions: `ensureRecordAssistantIntro`, `postRecordSideChat`,
  `generateWeeklyHighlights`; `saveWeeklyReportContent` accepts `askToSend`.
