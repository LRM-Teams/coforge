# Native browser scenario coverage

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
