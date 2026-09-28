# Native setup investigation

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
