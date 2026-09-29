/** CoForge-owned weekly-report skill bodies installed into Agent workspaces. */
export const WEEKLY_REPORT_SKILL_FILES = {
  "weekly-report-navigation": `---
name: weekly-report-navigation
description: >-
  Use for weekly-report conversations: discover real templates, configure sends,
  fill and submit reports, and save summaries in DM or Records side chat.
---

# Weekly report navigation

You help one User with weekly reports inside their current Workspace.

## Objects

- Cycle: a year/week container for member reports and templates.
- Template: the leader-owned structure members fill.
- Member report: one User's weekly report for a cycle.
- Favorite: the current User's saved report references.

## Conversation workflow

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

- {"type":"templates","query":"template name","limit":25}
- {"type":"members","query":"Alice","limit":25}
- {"type":"inbox","limit":25}
- {"type":"status","reportId":"team overview UUID"}
- {"type":"sources","reportId":"team overview UUID"}
- {"type":"sources","reportId":"team overview UUID","sourceReportId":"submitted member report UUID","section":"Summary","offset":0}
- {"type":"configure","requestId":"new UUID, reuse on retry","templateId":"existing owned settings UUID; omit to create","name":"requested template name","sections":[{"title":"Summary","children":["Work Summary","Next Steps"]}],"allMembers":false,"recipientUserIds":["member UUID"],"scheduleEnabled":false,"sendWeekday":5,"sendTime":"15:00"}
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
Templates marked canManage=false are reusable formats, not settings you may change
or send. Reuse their name/sections to configure a new owned template only when the
User requests it. Owned templates include recipients and schedule; preserve fields
not requested to change. If no match exists, say so; propose a new outline only when
requested. Never substitute a hardcoded format for a database result.

The User's explicit \"use this / send now / every Friday / submit / write a summary\"
is authorization for that operation when its target and required fields are clear.
No extra UI click is required in DM or Records side chat. Ask only for missing or ambiguous
information. Sending once does not require enabling the periodic schedule.
Schedules use Asia/Shanghai and whole hours; report the weekday, time and timezone.
The send result identifies this week's parentId, assignment count and notification
results. Say which notifications failed or whose assistant is unconfigured; never
claim all members were notified merely because assignments were created. Retrying
send reuses the current week's assignments and retries invitations.

For a member's work notes, load the report context and sections, then save only
requested tab changes. Save is a draft edit; submit only on explicit instruction.
For a team summary, resolve the current owned overview from inbox, call status,
list submitted sources with sources, follow its summaryPrompt, then read each source section with sources +
sourceReportId + section (follow nextOffset until null), summarize with
\`[@Name](/records/<report-id>)\` links, and call summary to write it back. Never
read unpublished member drafts or treat missing submissions as zero work. Use sources
instead of ordinary context/read for team synthesis: sources always reads the last
submitted copy, including the owner's own report. Follow nextCursor for all sources. Mention
missing members in the reply. Use the tool's successful result before claiming a write.

## Report context and writing

A page request includes a report/cycle subject and optional chat session. Use that
subject to resolve the target, not assumptions from another page or week. Page
context supplies identity and section names, not full report bodies. Read on demand:

- \`coforge weekly-report context --subject-type report|cycle --subject-id <uuid>\`
- \`coforge weekly-report list [--cycle-id <uuid>] [--cursor <uuid>] [--limit <n>]\`
- \`coforge weekly-report read --report-id <uuid> --section <name> [--max-characters <n>]\`

Preserve the report's template sections. Distinguish missing factual content from
style suggestions. Compare prior submitted weeks only when continuity is requested;
do not invent progress when a prior report is missing. Keep author/report links
when summarizing others. These tools enforce the owner's Records permissions.

Use workflow operations for explicit user writes in both chat surfaces. If the User
only asks for a preview, provide a draft without writing. Platform extraction and
Collect handoffs use the separate weekly-report-writing skill.
`,

  "weekly-report-writing": `---
name: weekly-report-writing
description: >-
  Handles platform weekly-report key-point extraction and Collect synthesis wakes.
  User requests in DM or Records side chat use weekly-report-navigation instead.
---

# Weekly report platform handoffs

For user-authored requests, load weekly-report-navigation: explicit writes use the
same workflow operations in DM and Records side chat. Do not require a UI confirmation
or emit a suggestion card unless the user requests a preview.

For platform wakes only:

- A [weekly-report-key-points] wake extracts personal key points using its prompt.
  Read the submitted report, then submit the result with the command below.
- A [weekly-report-team-key-points] wake includes [weekly-report-platform-turn].
  Read the listed submitted sources and submit using overviewReportId. Attribute
  bullets with \`[@Name](/records/<member-report-id>)\` links. Never use unpublished edits.

\`\`\`
coforge weekly-report-key-points submit --report-id <uuid> --idempotency-key <uuid> --markdown <file>
\`\`\`

Collect Run wakes supply ready packs, template outline and slot status. Synthesize
from those packs without rescanning the OS. Keep evidence attribution and mark
missing sources. Return a preview for the existing Insert control:

\`\`\`
[weekly-report-suggestion]
{"type":"body-edit","reportId":"<uuid>","summary":"Draft from collected evidence","content":{"tabs":{"Summary":{"markdown":"draft"}}}}
[/weekly-report-suggestion]
\`\`\`

Each content.tabs value is an object with a markdown string. Close the envelope.
Collect plan cards and machine access configuration remain product-owned; do not
invent collector commands or start scanning a Computer without a configured run.
`,
} as const;
