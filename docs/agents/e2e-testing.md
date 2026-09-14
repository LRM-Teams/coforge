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
browser steps are manual/agent-browser verification, not yet an unattended test.

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
then invokes setup from `install/active`. It deliberately does not claim a browser
reply from setup success. Follow the browser steps above and distinguish the
Agent reply from the user's request; reload to verify persistence.

Importing the caller's model key into the systemd user environment happens before
starting native services. A shell export alone does not update an already-running
Daemon. Use `coforge-computer restart` after changing its environment. Directly
restarting a Workspace systemd unit during this investigation left the live
Coordinator's recorded runtime identity stale; the installer correctly refused
upgrade with `Workspace runtime set is unhealthy`. The official restart command
recovered it, after which the unchanged setup script passed. Do not suppress that
health check or replace the active executable manually.
