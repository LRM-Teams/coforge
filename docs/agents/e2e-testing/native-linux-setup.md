# Native Linux verification and repeatable setup

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
