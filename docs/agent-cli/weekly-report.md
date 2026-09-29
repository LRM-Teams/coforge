# Weekly report

The private weekly-report Agent handles collections in its owner's DM or Records side chat.
Commands use the existing Credential Proxy and Agent HTTPS API, authorized as
that assistant's owner. Ordinary Agents and other Workspace principals are denied.

## Discover without a page

- `coforge weekly-report templates`: real Workspace template formats, even before
  any report or cycle exists. Both chat surfaces use the same catalog. `canManage`
  marks owned settings; only those entries include recipients and schedule.
  Other entries are reusable outlines. Ask to create an owned template before
  configuring or sending them. An empty report list is not an empty template catalog.
- `coforge weekly-report members`: Workspace members for recipient selection.
- `coforge weekly-report inbox`: owned formats, team overviews and member reports,
  including drafts. Select the intended week and report explicitly.
- `coforge weekly-report context --subject-type report|cycle --subject-id <uuid>`:
  compact subject metadata, section names and available data.
- `coforge weekly-report list`: authorized submitted member reports.
- `coforge weekly-report read --report-id <uuid> --section <name>`: bounded section
  text. A leader reads the last submitted version, never subsequent unsent edits.

## Complete the collection

Use `coforge weekly-report workflow --input <json-file>`. The file contains one
of these action objects; IDs come from discovery results, not invented handles.

| `type` | Fields | Result |
| --- | --- | --- |
| `templates` | optional `query`, `cursor`, `limit` | Settings and sections |
| `members` | optional `query`, `cursor`, `limit` | Member IDs and names |
| `inbox` | optional `cursor`, `limit` | Owned reports and weeks |
| `configure` | `requestId`, optional `templateId`, `name`, `sections`, `allMembers`, `recipientUserIds`, `scheduleEnabled`, `sendWeekday`, `sendTime` | Saved settings ID |
| `send` | `templateId` | Current-week overview, assignment count and invitation results |
| `status` | `reportId` of owned overview; optional `cursor`, `limit` | Submitted and outstanding member reports |
| `sources` | overview `reportId`; optional `cursor`, `limit`; `sourceReportId` + `section` + optional `offset` to read | Submitted-source metadata or bounded section text |
| `save` | `reportId`, `tabs` | Updated working draft |
| `submit` | `reportId` | Published member report |
| `summary` | `reportId`, `markdown` | Summary written to existing key points |

A section is `{ "title": "Summary", "children": ["Work Summary", "Next Steps"] }`.
`tabs` maps existing section names to `{ "markdown": "…" }`.
`requestId` is a UUID reused when retrying creation; supply `templateId` to edit
existing owned settings. Template names accept 1–100 characters. Discovery pages
have at most 50 results; follow `nextCursor` through workflow actions.
Creation commits settings and any initial live format together; an initialization
failure rolls both back and can be retried with the same `requestId`. Updating
sections also updates an existing live format when the recurring schedule is off.

Schedules use Asia/Shanghai, ISO weekdays 1–7, and whole-hour `HH:00` times.
One-off sending works without enabling a recurring schedule. All send entry
points serialize on the existing settings row and reuse that week's collection.
Retries reuse the assignments and retry invitations; later due ticks retry failed invitations too.
Team synthesis uses `sources` and its configured `summaryPrompt`, including for the owner’s own submitted report;
follow `nextCursor` and section `nextOffset` until null to read complete sources. Invitations are canonical
messages from each recipient's own private assistant, never public-channel notices.
A missing Computer assignment is reported as `assistant_unconfigured`, not success.
`notified` means the canonical invitation was persisted; realtime and device push
follow the existing best-effort messaging contract, not a read receipt.

A clear user request authorizes the corresponding operation in either chat surface: selecting a
format, specifying recipients/time, submitting, or writing a summary needs no
additional page click. Ask about ambiguous targets or missing required fields.
Requested previews and platform Collect drafts use Insert; collection requests use
a fillable plan in DM or Records side chat:

```text
[weekly-report-suggestion]
{"type":"collect-plan","reportId":"<member report UUID>","year":2026,"week":40}
[/weekly-report-suggestion]
```

Resolve the actual member report and week through context/inbox. The card lists
owned Computers and lets the User configure their persistent per-Computer collector,
select paths/time, and submit. In DM, configuration opens the Agent profile in place;
the plan retains its fields and refreshes readiness. Pending fields and submitted
run references are restored from browser storage after remount or refresh. Submit dispatches the existing
Collect Run and synthesis flow. A selected unready Computer blocks submission instead
of being silently omitted. Later plans reuse the configured collectors.
Do not use a generic `agent:create` card, guess collector commands, probe SSH or
search home directories/other Agents' memory to discover collectors. Not-ready does
not establish that the Computer daemon is missing. Agent ownership remains human;
the assistant proposes the card and the authenticated User configures/submits it.

Existing pending preview cards remain usable; new user sends and summaries are
handled by the Agent, without a separate keyword-triggered write path.
Workspace members may manage their own settings during the current MVP. They
cannot edit another member's drafts or another owner's configuration.

## Verification

Against an isolated PostgreSQL database with current migrations:

```sh
WEEKLY_REPORT_TEST_DATABASE_URL=<local-test-url> mise exec -- bun test ./apps/web/test/weekly-report-workflow.integration.ts
```

The integration test verifies creation retries, concurrent sending, private DM
invitations, member editing/submission, delivered snapshots and summary write-back.
Deploy the compatible Web backend before upgrading the Computer/Daemon; the
new CLI actions and assigned skill text require that client upgrade.

On the next Agent launch after upgrading Computer/Daemon, unchanged built-in
weekly-report skills are refreshed and redundant analysis/review/privacy files
are retired. Exact historical hashes identify old installs without a management
marker. Modified or unknown user skills are preserved and may still contain old
instructions; review those overrides if behavior differs after upgrading.

Manual acceptance: ask the same template question in DM and a report side panel,
choose a format, send immediately and retry after cancellation, submit member
notes, then request a team summary. Verify saved page content refreshes, source
links use submitted copies, custom summary prompts apply, and old Insert cards
still work. Repeat after upgrading an existing assistant, not only a fresh one.
