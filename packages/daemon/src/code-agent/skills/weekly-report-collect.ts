/** CoForge-owned collect skill (ported from Multica period-work-collect intent). */
export const WEEKLY_REPORT_COLLECT_SKILL_FILES = {
  "weekly-report-collect": `---
name: weekly-report-collect
description: >-
  Collect work evidence on this Computer for a CoForge weekly-report Collect Run.
  Use when woken to build a collector pack and submit it over Agent HTTPS.
  Only include work attributable to the report owner — never teammate-wide history.
---

# Weekly report collect

You harvest **work traces on this machine only**. Never scan another Computer.

## Owner scope (required)

This pack is for **one User** (the report author / Collect Run owner). Include
only evidence that belongs to that person. Do **not** dump whole-repo or
whole-team history.

Wake may list \`ownerUsername\`, \`ownerDisplayName\`, \`ownerGitHubLogin\`. Also
read this machine's \`git config user.name\` / \`user.email\` for the local
identity of that owner.

### Git / VCS

1. Prefer commits authored by the owner: match \`git log --author\` against
   owner username, display name, GitHub login, and local \`user.name\` /
   \`user.email\` (case-insensitive substring / email match).
2. Include the owner's dirty / uncommitted work in-window.
3. Exclude others' commits, PR lists, and release notes that are not the
   owner's contribution. Shared files the owner edited are OK; credit only
   their changes when summarizing.
4. Never use bare \`git log\` / \`git shortlog\` without an author filter when
   the repo has multiple contributors.

### Other sources

- Document / code file mtimes: keep files the owner likely edited; skip bulk
  vendor trees and teammate-only paths when attribution is clear.
- Chat / ticket exports: only the owner's messages or tickets assigned to them.
- If you cannot attribute an item to the owner, omit it.

State the attribution rule you used in a short \`## Attribution\` section of
the pack (e.g. git author filters).

## Scan roots

1. Prefer paths from the wake message \`scanPaths\` list when non-empty.
2. Otherwise use Computer-local collect-roots when available.
3. If still empty, use heuristic SCAN_ROOTS: first-level HOME children named like
   \`code\` \`src\` \`work\` \`repos\` \`Documents\` \`Desktop\` / \`文档\` \`桌面\`.
   Never deep-walk \`$HOME\` (skip AppData, Library, Downloads, .cache).

## Window

Respect wake \`windowStart\` → \`windowEnd\` (half-open RFC3339). Drop out-of-range
evidence. Prefer git repos with **owner** commits or dirty files in-window; also
non-git source-like and office files with mtime in-window when owner-scoped.

## Output

Build a Markdown **采集包** with Highlights, Repos / Work groups, and short diffs
**of the owner's work only**. Do not write the final weekly report body.

## Submit

Prefer the Agent CLI (Credential Proxy injects the API key):

\`\`\`
coforge weekly-report-collect submit-pack --run-id <uuid> --request-id <uuid> --markdown <file>
coforge weekly-report-collect submit-empty --run-id <uuid> --request-id <uuid>
coforge weekly-report-collect submit-failure --run-id <uuid> --request-id <uuid> --reason <text>
\`\`\`

Or POST the same JSON to the Credential Proxy route:

\`POST /api/agent/v1/weekly-report-collect\`

JSON body:

\`\`\`json
{
  "requestId": "<uuid>",
  "runId": "<from wake>",
  "outcome": "ready",
  "packMarkdown": "<markdown>"
}
\`\`\`

Empty evidence: \`"outcome":"empty"\`. Failure: \`"outcome":"failed","failureReason":"..."\`.
`,
};
