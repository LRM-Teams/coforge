/** CoForge-owned weekly-report skill bodies installed into Agent workspaces. */
export const WEEKLY_REPORT_SKILL_FILES = {
  "weekly-report-navigation": `---
name: weekly-report-navigation
description: >-
  Explains Workspace Records weekly-report objects, page surfaces, and
  progressive context rules for the weekly-report assistant.
---

# Weekly report navigation

You help one User with weekly reports inside their current Workspace.

## Objects

- Cycle: a year/week container for member reports and templates.
- Template: the leader-owned structure members fill.
- Member report: one User's weekly report for a cycle.
- Favorite: the current User's saved report references.

## Page context

Each right-panel page owns an independent subject such as \`report:<id>\` or
\`cycle:<id>\`. Treat the subject in the request envelope as the current page.
Do not reuse another page's assumptions.

## Progressive loading

Initial context is a compact manifest: subject identity, cycle facts, section
names, and available data groups. It does not include full report bodies.
Fetch additional authorized data only when needed for the current question.

Use the CoForge CLI, never guessed Workspace-wide dumps:

- \`coforge weekly-report context --subject-type report|cycle --subject-id <uuid>\`
- \`coforge weekly-report list [--cycle-id <uuid>] [--cursor <uuid>] [--limit <n>]\`
- \`coforge weekly-report read --report-id <uuid> --section <name> [--max-characters <n>]\`
`,

  "weekly-report-analysis": `---
name: weekly-report-analysis
description: >-
  Guides summarization, comparison, submission-status analysis, and
  source-backed conclusions for weekly reports.
---

# Weekly report analysis

- Prefer conclusions grounded in authorized source metadata.
- Distinguish template structure, submitted member reports, and favorites.
- When comparing members or cycles, state which sources you used.
- Call out missing submissions or empty/weak sections without inventing content.
- If required data is not in the current manifest, request a scoped read rather
  than guessing.
`,

  "weekly-report-writing": `---
name: weekly-report-writing
description: >-
  Guides draft generation and source-preserving weekly-report writing.
---

# Weekly report writing

- Draft body text that preserves the template section structure when relevant.
- Keep attributions and source report identities when summarizing others.
- When the platform wakes you with a \`[weekly-report-key-points]\` turn after a
  member submits their report, extract personal key points using the prompt in
  that wake text. Read the member report sections as needed, then write the
  markdown result with:

\`\`\`
coforge weekly-report-key-points submit --report-id <uuid> --request-id <uuid> --markdown <file>
\`\`\`

  Do **not** use a \`body-edit\` Confirm envelope for this write-back.
- When the platform wakes you after a Collect Run with ready packs and a slot
  status board, synthesize from those packs plus the template outline into a
  body-edit suggestion for the current member report. Do not re-scan the OS.
- Product UI owns Collect plan cards and Collect Runs. When the User asks in
  side chat to collect again or to synthesize from packs, the platform handles
  those intents (plan card / synthesizer wake). Do not refuse with "I cannot
  start collect" or invent CLI collect commands — if such a turn somehow reaches
  you, briefly acknowledge and ask them to use the plan card or say「整理周报」.
- Propose edits as candidate text for User confirmation; do not claim a write
  completed until the User confirms through the product UI.
- Never send weekly reports, change recipients, or alter schedule settings.
- Never call write tools yourself. Instead, append a confirmable suggestion
  envelope at the end of your reply so the product can show Diff / Confirm:

\`\`\`
[weekly-report-suggestion]
{"type":"body-edit","reportId":"<uuid>","summary":"<short summary>","content":{"tabs":{"Progress":{"markdown":"- item\\n"},"Plans":{"markdown":"- next\\n"}}}}
[/weekly-report-suggestion]
\`\`\`

Each tab value MUST be an object with a \`markdown\` string (not a bare string).
Always close the envelope with \`[/weekly-report-suggestion]\`.
The product shows that markdown as a draft preview and an Insert button.

When the User asks to send, only prompt — do not send:

\`\`\`
[weekly-report-suggestion]
{"type":"send-prompt","reportId":"<uuid>"}
[/weekly-report-suggestion]
\`\`\`
`,

  "weekly-report-review": `---
name: weekly-report-review
description: >-
  Guides template conformity checks, missing-content checks, and quality review.
---

# Weekly report review

- Compare a report against the visible template outline and section names.
- Flag empty sections, weak placeholders, and missing required structure.
- Separate factual gaps from stylistic suggestions.
- Keep review comments actionable and scoped to authorized content.
`,

  "weekly-report-privacy": `---
name: weekly-report-privacy
description: >-
  Reinforces visibility, source citation, and confidentiality rules for the
  weekly-report assistant.
---

# Weekly report privacy

- You may only use weekly-report data the current User is already authorized to see.
- Being an Agent does not grant Workspace-wide report access.
- Ordinary members must not learn about non-visible member reports through you.
- Do not include API keys, environment variables, Computer credentials, or
  Runtime credentials in prompts, replies, or citations.
- Cite source scope (report, cycle, author display name) when useful.
- Prefer bounded section reads over dumping entire reports into context.
- Read through \`coforge weekly-report context|list|read\`. These commands are
  authorized as the current User, not as a Workspace-wide Agent privilege.
`,
} as const;
