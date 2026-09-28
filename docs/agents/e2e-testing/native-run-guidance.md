# Native run guidance

Run repository builds before starting the native browser scenario, never in
parallel with it against the same Web output directory. A concurrent build
removed assets from underneath the running server, producing ENOENT and leaving
the SSR message form unhydrated. Restart the managed Web service after rebuilding
and verify the new RPC endpoint responds before invoking the installed Computer.
An old running build can return HTML for a newly added endpoint; that is not
evidence of a protobuf or authorization defect.

The extended native browser scenario subsequently passed **1 test, 37 assertions**
using production instructions and OpenRouter `deepseek/deepseek-v4.1-flash`.
It includes offline Task recovery: await the installed Computer's public `stop`,
create a Task, run public `start`, and observe the Agent-owned task reach
In review and persist after reload. Do not wait on the Web Online badge as proof
of shutdown: its loader snapshot and 90-second presence lease are not the local
process lifecycle contract.

The same run asked the Agent to mute `#general`, create an unassigned Task, then
handled human assignment and persisted In review. Separately inspected native
Pi tool records confirmed `coforge channel mute --target '#general'` returned
`accepted: true` with no intervening unmute. The automated browser assertions
verify assignment and completion, not the mute flag itself; retain this evidence
distinction rather than claiming automated mute-state coverage.

Match Task titles exactly: the Agent may legitimately create a planning Task
whose longer title also contains the requested title. Substring matching selected
the wrong Task during investigation. Cleanup must attempt Computer restart,
temporary-directory removal, and browser close even if another cleanup fails,
while retaining the original scenario failure.

For future recovery coverage, do not substitute intentional Agent Stop for a
Daemon disconnection: Stop revokes capabilities and removes restart configuration.
Likewise, the Web channel mute control changes the human's membership, not the
Agent's. Agent mute must use the production Agent command. Non-general channels
do not currently expose an add-Agent UI; `#general` enrolls Workspace members,
and Task reassignment requires the assignee to belong to that conversation.

Browser selectors must use observed accessible names, not inferred function
names: this UI uses **View and edit** and **Assignee handle**. Use the explicit
Close button for Task detail: Escape did not dismiss it during this run. Initial
failures were incorrect test selectors/dismissal assumptions, not Task delivery
failures; no production behavior was changed to make this scenario pass.

## Fast browser input exposed a production hydration defect

Before hydration, the SSR message textarea accepted text with no React handler.
Hydration then reset it to the initial empty value. This was not a delivery or
model failure: the request never left the browser. A diagnostic confirmed the
element had no React props; the server-rendered textarea was also enabled.
The shared conversation composer now uses TanStack Router's `useHydrated` to
disable inputs/actions until hydration completes, retaining the normal sending
state afterward. This follows the official [hydration guidance](https://playwright.dev/docs/navigations#hydration).
The browser regression checks the actual SSR textarea is disabled, waits for the
live control to enable, confirms its entered value, observes the sent user row,
and only then waits for the separate Agent reply. Do not add sleeps, mutate React
internals, or resend lost text to hide this failure.

Navigation and closing menus/dialogs have observable completion states; the test
waits for those rather than clicking through an overlay. Model reply markers avoid
sentence-ending punctuation: one real response omitted a requested final period,
which is not evidence of a transport failure. Exact marker and sender checks remain.

Importing the caller's model key into the systemd user environment happens before
starting native services. A shell export alone does not update an already-running
Daemon. Use `coforge-computer restart` after changing its environment. Directly
restarting a Workspace systemd unit during this investigation left the live
Coordinator's recorded runtime identity stale; the installer correctly refused
upgrade with `Workspace runtime set is unhealthy`. The official restart command
recovered it, after which the unchanged setup script passed. Do not suppress that
health check or replace the active executable manually.
