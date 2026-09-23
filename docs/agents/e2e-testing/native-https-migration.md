# Native CLI fix and HTTPS setup migration

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
