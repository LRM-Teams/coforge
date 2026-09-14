# Live OpenRouter integration test

Run `scripts/e2e/run-openrouter-live.sh` from an Amp orb with the repository's
E2E services and a real `OPENROUTER_API_KEY` supplied through the environment.
The runner starts the declared services and reads their generated credentials.
Never replace the caller's key with a diagnostic placeholder, print credentials,
or claim a real model call based only on credential presence.

The test uses production Agent instructions and OpenRouter model
`deepseek/deepseek-v4.1-flash`. Success requires canonical Agent replies in
PostgreSQL, not just model completion or a delivery ACK. It checks ordinary
channel replies, muted-channel suppression, personal mention bypass, and
followed-thread delivery and replies in the correct thread.

## Coverage boundary

This is a Daemon integration test, not native Computer installation/setup E2E.
It invokes registration/message application modules, starts DaemonRuntime
in-process, and injects a Pi Provider and a limited inventory. WSS, Agent
sessions, OpenRouter inference, message persistence, and delivery ACKs are real.
Native Computer setup, process supervision, and complete inventory publication
are verified separately in the native procedure below. Do not advertise the
in-process OpenRouter test as covering them.

## Diagnoses established during recovery

- Pi's default model runtime creation does not enable network catalog refresh.
  A valid API key alone does not guarantee a newly released model is available.
  Use the SDK's supported catalog refresh, not a test-only model definition.
- A newly created Session can legitimately be empty. Waiting for a nonempty
  transcript before sending its first message deadlocks the test's ordering.
  Observe successful session creation, then send through the application seam.
- A muted root message is not automatically supplied as thread context. Put
  the requested test reply in the delivered thread message. Keep assertions for
  the destination thread, delivery ACK, and persisted reply.
- Never satisfy a failed stage by injecting ACKs, invoking a second Agent start,
  overriding production instructions, skipping authorization, or dropping the
  canonical reply assertion.
- Polling deadlines and failures must identify the awaited stage. Formatting
  and type checks do not establish E2E success.

## Recovery checkpoint verification

The Provider-based test passed on 2026-09-14: **1 pass, 0 fail, 11 assertions**
in 82.41 seconds with the environment's real OpenRouter key. `mise run check`
and `mise run build` passed. `mise run test` failed in ConversationHistory's
around-window test and runtime inventory's catalog test; the full suite is not
green.

Oracle's focused review permits draft preservation, not merge approval. Open
findings: the restored three-catalog bound rejects supported multi-Provider
inventories; Kiro usage behavior/tests were lost in the older snapshot; catalog
refresh before managed credential installation misses managed-key-only cold
starts. Resolve these and rerun checks before requesting merge approval. The
review did not cover all recovered Task/schema changes.

## Follow-up verification

The checkpoint regressions above are now fixed. `mise run test`,
`mise run check`, and `mise run build` all passed on 2026-09-14.
`scripts/e2e/run-openrouter-live.sh` passed with **1 test, 0 failures,
11 assertions** in 40.10 seconds using the real OpenRouter key and production
instructions. The coverage boundary above still applies.

The follow-up also exposed two test-isolation errors: global HTTP mocks in
credential issuance/revoke tests intercepted unrelated online model inventory
requests. One recorded an unexpected catalog request; the other consumed the
intended first-revoke 503 response during catalog discovery. These tests now
inject inventory through the existing discovery seam, retaining all original
authentication and retry assertions. Do not disable production discovery or
weaken those assertions to accommodate the mocks.

Oracle reviewed the follow-up diff with no blockers; this does not constitute
review of the entire recovered checkpoint. Catalog refresh still deliberately
forces revalidation and has a five-second network deadline, so an online cold
start can incur that delay even when a cached catalog exists.

## Native setup investigation

The managed Web service now disables the automatic device-authorization double.
Verify discovery advertises `/api/workspaces`, not `/api/e2e/workspaces`, and
the device-code grant. Browser identity is still the explicitly configured
development user; this does not verify the external identity provider login.

A compiled Computer completed real device authorization on 2026-09-14:
open the exact verification URL printed by `login --json`, confirm the code,
and click Approve. The CLI returned `ok: true`, `binding_created: false`,
`daemon_started: false`, as required for login only. Use that URL rather than
filling a formatted, hyphenated code through automation's raw input setter;
the OTP field expects eight characters and normalizes actual paste events.

The initial native setup attempt failed: `setup --workspace dev-user --json`
returned `SETUP_DAEMON_START_FAILED`. Two harness prerequisites
were missing, not established product defects:

- The isolated HOME received the service file, but the real systemd user
  manager uses `/home/user`; `systemctl --user status coforge-daemon.service`
  reported the unit was not found. Changing a CLI's HOME does not change the
  already-running user's service search path.
- The harness compiled a binary but never installed it. The service points at
  `<home>/.coforge/computer/install/active/coforge-computer`, which does not
  exist. Compilation must not be reported as installation.

This orb supports real systemd: PID 1 is systemd, and starting `user@1000.service`
then using `XDG_RUNTIME_DIR=/run/user/1000` produced a running user manager.
The initial missing user bus was not evidence that native testing was impossible.
Computer also requires HTTPS. The native investigation used a local Caddy TLS
endpoint with its CA explicitly trusted, never disabled Computer TLS checks.
The reusable native harness now prepares a verified installation and checks the
user-manager environment before running setup.

## Native Linux verification and repeatable setup

Verified on 2026-09-14 with a local host-platform package, not a published release:

1. The production `__install-local` bootstrap entry verified manifest and gzip
   identities and installed the unified Computer executable in its version store.
2. The installed `setup --workspace dev-user --json` used real browser device-code
   approval and returned `server_registration_created: true`, `daemon_started: true`.
3. Both Coordinator and Workspace systemd services were active; the Computers
   page showed Online and the actual runtime inventory.
4. Through the browser, publish Pi, create `native-e2e` on that Computer, select
   OpenRouter / DeepSeek V4.1 Flash, open Private chat, and send
   `Reply with exactly: native Computer E2E confirmed.` The Agent replied.
5. Repeat the setup script (verified native upgrade), then send
   `Reply with exactly: native installed rerun confirmed.` A separate Agent reply
   appeared. Reloading the page retained both replies and showed Online.

This uses production instructions, native services and real OpenRouter inference.
It does not inject a Provider, DaemonRuntime, Agent start, reply, or ACK from test
code. Browser identity still uses the development user. Public CDN download,
external identity-provider login, macOS, and Windows are not covered. The native
browser steps are now automated in `scripts/e2e/native-browser.e2e.ts`. First-time
device authorization still requires browser approval; subsequent runs reuse the
normal saved login and run through the final reply without manual interaction.

Run in a disposable **OS user**, not a fake HOME. Prepare the normal E2E services,
a running systemd user manager, and trusted local HTTPS. In this orb, Caddy 2.10.2
uses `tls internal` on `https://localhost:8791`, reverse-proxying port 8790; export
its readable root certificate path as `NODE_EXTRA_CA_CERTS`. No TLS validation
is disabled in Computer. Keep this TLS proxy running for the installed services.

```sh
amp orb services ensure
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user is-system-running
# OPENROUTER_API_KEY is supplied securely by the environment.
export NODE_EXTRA_CA_CERTS=/path/to/local-caddy-root.crt
export COFORGE_E2E_WEB_URL=https://localhost:8791
export COFORGE_E2E_WORKSPACE_SLUG=dev-user
COFORGE_E2E_ALLOW_INSTALL=1 scripts/e2e/run-computer-setup.sh
```

The script builds a unique fixture version, packages it, calls the real installer,
then invokes setup from `install/active`. It extracts the registration path from
the CLI result and runs the browser test against that Computer. The test selects
Pi and DeepSeek V4.1 Flash through the UI, creates a uniquely named Agent, sends a
unique `NATIVE_E2E_...` marker request, and requires an exact reply from the Agent's
message row both before and after reload. Created Agents/messages are retained
in the disposable Workspace for manual inspection; browser sessions always close.
Failure snapshots go to `.amp/e2e/native-browser-failure.txt`; a successful reload
screenshot goes to `.amp/in/artifacts/native-browser-reply.png`. Browser Chromium
ignores the local test certificate error; native Computer still validates its
explicitly trusted CA. Do not use this harness against shared environments.

The combined native setup/browser command passed on 2026-09-14, with the browser
portion reporting **1 pass, 0 fail, 7 assertions** in 12.00 seconds. A subsequent
`--rerun-each 2` browser run passed both iterations, **14 assertions** in 33.35
seconds. These were real OpenRouter calls, not fixture responses.
After the diagnostic cleanup changes, the final browser run also passed:
**1 pass, 0 fail, 7 assertions**, 9.67 seconds. Repository `test`, `check`, and
`build` passed; targeted E2E oxfmt/oxlint, shellcheck, and TypeScript checks passed.
Oracle found no blockers in this incremental change. Channel SSR/live DOM checks
also observed disabled-before-hydration and enabled-after-hydration behavior.
Thread entry and send-error recovery remain manual regression checklist items;
this direct-chat E2E does not claim to cover them.

The native browser test now also uploads `read-me.txt` through the production
composer and asks the real Agent to reply with its contents. Its random marker
is absent from the request, and the temporary source file is outside the Agent
workspace and removed after upload. After the Agent replies, the test reloads,
checks both replies and the attachment card, and fetches the persisted attachment
through its normal authenticated Web URL, asserting HTTP 200 and exact contents.
On 2026-09-14 this extended test passed: **1 pass, 0 fail, 12 assertions**, 32.62
seconds, using the installed native Computer and DeepSeek V4.1 Flash on OpenRouter.
The inspected screenshot shows the attachment and separate Agent content reply.
This covers Web upload/send and Agent access to the contents, not proof of a
particular CLI tool invocation, Agent-originated upload, or attachment comments.

The same native browser scenario now creates a uniquely titled Task in the DM's
Task board, verifies it is initially unassigned, assigns it to the real Agent,
then observes its card under **In review** with that Agent as owner. Reload must
preserve both owner and status. No test code claims or advances the Task to review.
On 2026-09-14 the combined message/attachment/Task scenario passed: **1 pass,
0 fail, 16 assertions**, 42.82 seconds. The native Pi session independently showed
`coforge task claim --target "@dev-user" --number 1`, result `#1: claimed`, and
`coforge task update --target "@dev-user" --number 1 --status in_review`.
The Agent's `task-result.txt` contained `task received`; the refreshed board
screenshot was inspected. These tool/file checks were diagnostic inspection,
not additional automated browser assertions. This does not isolate assignment
receipt wake-up from initial Task-message delivery or cover offline recovery,
channel mute or reassignment.

The scenario now completes human acceptance through the production status picker:
after observing the Agent's persisted **In review** card, the browser selects
**Done**. It verifies the same title and owner in Done, reloads, checks they remain,
and checks the card is absent from In review. Before reload it waits for the
card's `aria-busy` saving state to clear; optimistic movement is not persistence.
The final combined run passed on 2026-09-14: **1 pass, 0 fail, 20 assertions**,
55.40 seconds. Its inspected screenshot
is `.amp/in/artifacts/native-browser-task-done.png`; the card truncates the owner
visually, while the DOM assertion checks the full name.

Agent-originated creation is now a separate phase in the same real conversation.
The human asks for a new follow-up subtask with a unique `FOLLOWUP_...` title,
self-assignment, execution, and submission for review. The test requires a new
Agent-authored message with that exact title, then the matching Agent-owned card
in In review before and after reload. Clicking that card must navigate to the
same Agent-authored message ID; converting the human request cannot satisfy this.
The earlier Done task must remain Done. On 2026-09-14 the final combined run
passed: **1 pass, 0 fail, 25 assertions**, 45.60 seconds, with real OpenRouter
DeepSeek V4.1 Flash. Native session inspection also confirmed `coforge task create`
with the exact new title and the Agent's own handle. This remains a human-requested
Agent-created subtask, not evidence of unsolicited autonomous task planning.

Keep diagnostics out of the running test's browser session. A manual command
without the harness's session flags disturbed an earlier run and produced an
empty page; that run is not a product failure or a passing E2E. Inspect retained
logs or use a separate browser session instead.

The reassignment phase moves the Agent-created review task to the seeded human
`@dev-user`, then back to the Agent through the Task detail form. Each step checks
the new owner, absence of the old owner, unchanged In review status, reload
persistence, and the unaffected earlier Done task. Use the task card's actual
owner label (`@dev-user` here), not the login menu's `Dev User` label. Wait for the
board to load before resolving the specific card's action menu. Final combined
browser run: **1 pass, 0 fail, 31 assertions**, 67.65 seconds on 2026-09-14.
One earlier run failed because OpenRouter's Together upstream returned an HTTP/2
body-stream error; a passing rerun does not fix that external failure.

This extension exposed a production CLI defect before reaching reassignment:
`message check` discarded attachment metadata while `message read` preserved it.
The Agent received only prose and read a stale `/tmp/read-me.txt`, returning the
wrong marker. The exact-content assertion correctly failed. The CLI now prints
the existing attachment metadata (full ID, filename, type, size) beside the
message; a public CLI regression test failed before the fix and passes after it.
No prompt override, pre-download, or weakened content assertion was introduced.
The fix was compiled and installed through the native harness, then activated
with the normal Computer restart command. Repeated setup itself returned
`SETUP_WORKSPACE_LOOKUP_FAILED`; subsequent investigation confirmed the saved
login token had expired and the SDK emitted connection error 109. The initial fix
classified that documented error as `AUTH_LOGIN_EXPIRED`; Setup reauthorizes
once through the existing device-login flow and retries workspace lookup with
the replacement credential. Final failures still reach the CLI's existing outer
error handler. Do not globally retry Setup: registration and daemon startup must
not be replayed as error presentation. See the official
[Centrifugo error codes](https://centrifugal.dev/docs/server/codes) and
[authentication contract](https://centrifugal.dev/docs/server/authentication).
The native install/setup harness then completed real browser authorization and
the browser scenario passed **31 assertions**. Targeted setup/transport tests
passed **32 tests, 59 assertions**. Earlier attachment CLI tests passed
**35 tests, 96 assertions**.

The subsequently approved HTTPS migration removes those temporary WebSockets
entirely. Setup and attach now call `POST /api/computer/workspace` and
`POST /api/computer/attach` with the User bearer and `{ b64data }` protobuf body;
the route fixes the operation, not a client-supplied `method`.
HTTP or envelope authentication code 401
enters the same single reauthorization path; other failures do not replay Setup.
Daemon control still uses WSS. The old WSS lookup/register methods are removed.

HTTPS verification completed real device authorization, registration, and Daemon
startup (`ok: true`, `daemon_started: true`). The subsequent repeat-install run
did not complete: native upgrade reported local-handshake failure and failed
rollback shutdown confirmation. Later Daemon connect-proxy requests returned
401, and public setup reported `SETUP_DAEMON_START_FAILED`. Registration revokes
prior binding keys when issuing a replacement; the relationship between this
rotation and the failed local recovery needs investigation. Do not count the
earlier 37-assertion browser pass as verification of the HTTPS migration.

After allowing Coordinator recovery to finish, the installed public `stop`
succeeded. Re-running the unchanged native install/setup harness with the named
HTTPS endpoints then returned `ok: true` and `daemon_started: true`. A subsequent
installed `attach --workspace dev-user --json` also exited 0 with those results;
both Coordinator and Workspace systemd units were active. No configuration or
database records were deleted and no handshake was bypassed. This recovers the
test environment, but is not a code fix for the earlier upgrade failure.

That browser run reached 34 assertions (real reply, attachment, Task creation,
Agent-created Task, reassignment, and offline recovery) before failing while
opening `#general` for the muted-assignment scenario. The page displayed
"Messages could not be loaded" with error reference
`430c1bd3-1164-4887-a620-e9aaf5bac246`. Record this as a failed browser suite,
separate from the successful HTTPS setup and repeat attach; the page-load cause
remains unresolved.

The next full browser run, after adding numeric stack-position diagnostics at
the existing public error boundary, passed **1 test, 37 assertions** in 175.07s.
It verified real reply, attachment, Task review/Done, Agent-created Task,
reassignment, offline recovery, and muted assignment. The original exception
did not recur; this is a passing rerun, not a demonstrated root-cause fix or proof
of a network fault. Oracle approved the diagnostic increment without blockers.
Diagnostics exclude error messages, arbitrary error names/codes and file paths;
the disclosure regression suite passed **6 tests, 23 assertions**. A second
browser repetition was still running when the user requested submission; it is
not included in these passing results. The user explicitly accepted deferring
investigation of the intermittent page-load error for this submission.

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

### Fast browser input exposed a production hydration defect

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
