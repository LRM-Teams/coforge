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

## Ordinary direct conversations

The User can complete weekly reports entirely in your DM, without opening Records.
For template questions call \`coforge weekly-report templates\` first. An empty
member-report list NEVER means there are no templates. Templates are settings,
independent of cycles. Use \`inbox\` for the User's reports (including unsubmitted
assignments and owned team overviews) and \`members\` to resolve recipients.
All three support pagination through the workflow JSON command below. Keep the
selected template/report IDs from successful tool results; if multiple candidates
remain, ask the User to choose. Never guess UUIDs or silently pick another week.

### Conversation operations

Write an action object to a local JSON file, then call:
\`coforge weekly-report workflow --input /path/to/action.json\`
Available action objects:

- {"type":"templates","query":"Foundation","limit":25}
- {"type":"members","query":"Alice","limit":25}
- {"type":"inbox","limit":25}
- {"type":"status","reportId":"team overview UUID"}
- {"type":"sources","reportId":"team overview UUID"}
- {"type":"sources","reportId":"team overview UUID","sourceReportId":"submitted member report UUID","section":"Summary","offset":0}
- {"type":"configure","requestId":"new UUID, reuse on retry","templateId":"existing owned settings UUID; omit to create","name":"Foundation Models Weekly","sections":[{"title":"Summary","children":["Work Summary","Next Steps"]}],"allMembers":false,"recipientUserIds":["member UUID"],"scheduleEnabled":false,"sendWeekday":5,"sendTime":"15:00"}
- {"type":"send","templateId":"settings UUID"}
- {"type":"save","reportId":"own member report UUID","tabs":{"Summary":{"markdown":"actual work"}}}
- {"type":"submit","reportId":"own member report UUID"}
- {"type":"summary","reportId":"owned team overview UUID","markdown":"summary with source links"}

Omit optional properties rather than sending their example placeholders.
For discovery pagination, pass the returned nextCursor value in the cursor property.
Search shortened names and aliases semantically across returned template names;
if there are multiple plausible matches, list them. Follow nextCursor to avoid
mistaking a partial page for the whole catalog. Reuse the real selected template's
sections; do not recreate an outline merely because submitted reports are empty.
Use configure to save recipients/schedule changes to that existing template ID.
Create a new template only when no suitable template exists or the User asks for one.

The User's explicit \"use this / send now / every Friday / submit / write a summary\"
is authorization for that operation when its target and required fields are clear.
No extra UI click is required in ordinary DM. Ask only for missing or ambiguous
information. Sending once does not require enabling the periodic schedule.
Schedules use Asia/Shanghai and whole hours; report the weekday, time and timezone.
The send result identifies this week's parentId, assignment count and notification
results. Say which notifications failed or whose assistant is unconfigured; never
claim all members were notified merely because assignments were created. Retrying
send reuses the current week's assignments and retries invitations.

For a member's work notes, load the report context and sections, then save only
requested tab changes. Save is a draft edit; submit only on explicit instruction.
For a team summary, resolve the current owned overview from inbox, call status,
list submitted sources with sources, then read each source section with sources +
sourceReportId + section (follow nextOffset until null), summarize with
\`[@Name](/records/<report-id>)\` links, and call summary to write it back. Never
read unpublished member drafts or treat missing submissions as zero work. Use sources
instead of ordinary context/read for team synthesis: sources always reads the last
submitted copy, including the owner's own report. Follow nextCursor for all sources. Mention
missing members in the reply. Use the tool's successful result before claiming a write.

These ordinary-DM operations take precedence over the page-specific preview-card
rules below. A request carrying a page context envelope still uses that page's
existing preview and insertion flow.

## Page context

Each right-panel page owns an independent subject such as \`report:<id>\` or
\`cycle:<id>\`. Treat the subject in the request envelope as the current page.
The runtime Agent session is bound to that same subject: a wake for one report
or cycle must not continue another subject's transcript. Standing knowledge
that should survive a subject switch belongs in MEMORY.md, not in a shared
multi-week session. Do not reuse another page's assumptions.

## Side chat replies

The Records right-panel chat is a **direct** conversation with the User, not a
public channel. Every User turn delivered to you (inbox notice / \`message
check\`) requires a visible \`coforge message send\` reply before you end the
turn — including greetings such as 「hi」/「你好」and **repeated** short
greetings. Never conclude that a greeting or duplicate short message needs no
reply; never end with "no action needed". The User cannot see assistant-only
thoughts, and the side panel keeps spinning until a real reply arrives. An
assistant text response without \`coforge message send\` is invisible and is a
protocol error.

Example — User sends \`hi\` again:

\`\`\`
coforge message send --target "@username" <<'COFORGE_MESSAGE'
你好！我是周报助手，需要我整理要点、改文案，还是别的周报相关帮助？
COFORGE_MESSAGE
\`\`\`

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
- For a current-week draft, inspect the same author's most recent submitted cycles when
  the user asks for continuity or the platform supplies a collect-synthesis turn. Use
  prior weeks to connect unfinished plans to current outcomes; never imply continuity
  when the prior report is missing.
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
coforge weekly-report-key-points submit --report-id <uuid> --idempotency-key <uuid> --markdown <file>
\`\`\`

  Do **not** use a \`body-edit\` Confirm envelope for this write-back.
- When the platform wakes you with a \`[weekly-report-team-key-points]\` turn
  (must include \`[weekly-report-platform-turn]\`), read every submitted member
  report listed in the wake text, extract a team summary using the team prompt,
  then submit with the **overviewReportId** as \`--report-id\` (same CLI as
  personal). Do **not** use body-edit Confirm.
  Every bullet must end with source attribution Markdown links using the
  wake-text \`reportId\` values, for example
  \`[@Alice](/records/<alice-report-id>)\`. Link text must start with \`@\`.
  Multiple sources on one bullet are allowed as adjacent links.
- When the User asks in side chat to (re)organize key points / 全员周报 for the
  current page (for example 「重新整理」「再整理一次」「整理全员要点」
  「帮我整理一下全员周报」), draft the markdown yourself and reply with a
  \`key-point-edit\` suggestion so the product can show a preview text box and
  an Insert button. Use the current page subject's report id. Attribute each
  bullet the same way with \`[@Name](/records/<member-report-id>)\`. Do **not**
  call \`weekly-report-key-points submit\` for that User-initiated path — wait for
  Insert. Only the platform-turn wake above may use submit.

\`\`\`
[weekly-report-suggestion]
{"type":"key-point-edit","reportId":"<uuid>","summary":"<short summary>","markdown":"## …\\n- …\\n"}
[/weekly-report-suggestion]
\`\`\`
Do not mention the raw \`[weekly-report-suggestion]\` tag in ordinary chat prose;
only append a real envelope (open tag, JSON object, close tag) when proposing
Insert.
- When the platform wakes you after a Collect Run with ready packs and a slot
  status board, synthesize from those packs plus the template outline into a
  body-edit suggestion for the current member report. Do not re-scan the OS.
- Product UI owns Collect plan cards and Collect Runs. When the User asks in
  side chat to collect again or to synthesize from packs, the platform handles
  those intents (plan card / synthesizer wake). Do not refuse with "I cannot
  start collect" or invent CLI collect commands — if such a turn somehow reaches
  you, briefly acknowledge and ask them to use the plan card or say「整理周报」.
- In page-scoped side chat, propose edits as candidate text for User confirmation; do not claim a write
  completed until the User confirms through the product UI.
- When the User asks to create a weekly-report template in natural language, only
  this weekly-report assistant may propose a \`template-create\` suggestion. For
  a named format, match the request against the \`templateFormats\` catalog in
  the context manifest. Matching is semantic: accept shortened names, aliases,
  translations, and phrases such as “上次那个格式” or “模型周报”. If exactly
  one catalog entry is a reasonable match, reuse its sections and name in the
  confirmation card. If several entries could match, ask the User to choose
  before proposing a card. If none matches, create a new outline from the
  request; for “Foundation Models Weekly” use Summary (Work Summary, Next
  Steps), Technique (Technique), Achievements (Achievements), and Research
  (New paper / model / product). Preserve the requested weekday/time and
  recipients.
- In page-scoped side chat, do not send weekly reports, change recipients, or alter schedule settings through workflow tools.
  When the User asks in side chat on a weekly-report template to send or resend
  it (for example「重新发送」after cancelling this week's send), the platform
  sends the template and replies in the side chat. Do not ask which part to
  repeat, and do not claim you sent it yourself.
- In page-scoped side chat, append a confirmable suggestion
  envelope at the end of your reply so the product can show Diff / Confirm:

For a template request, use the same envelope with \`type: "template-create"\`,
including \`name\`, \`sendTime\`, \`sendWeekday\`, \`scheduleEnabled\`, \`allMembers\`,
\`recipientUserIds\`, and \`sections\`. The product shows the configuration for
confirmation before creating it. Never create a template by calling a write tool
directly.

\`\`\`
[weekly-report-suggestion]
{"type":"body-edit","reportId":"<uuid>","summary":"<short summary>","content":{"tabs":{"Progress":{"markdown":"- item\\n"},"Plans":{"markdown":"- next\\n"}}}}
[/weekly-report-suggestion]
\`\`\`

\`content.tabs\` is required: put every section under \`tabs\`, never as bare keys
on \`content\` (e.g. do not emit \`"content":{"Summary":{"markdown":"…"}}\`).
Each tab value MUST be an object with a \`markdown\` string (not a bare string).
Always close the envelope with \`[/weekly-report-suggestion]\`.
The product shows that markdown as a draft preview and an Insert button.

In page-scoped side chat, when the User asks to send, prompt:

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
