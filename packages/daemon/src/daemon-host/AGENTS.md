# daemon-host instructions

Rules for login-session startup in `src/daemon-host/`. They extend
`packages/daemon/AGENTS.md`.

- This directory owns startup through launchd, systemd user, and Windows task
  integration. It does not own Computer commands.
- Never fall back to a detached process when the platform manager is
  unavailable. Computer exposes foreground supervision as an explicit mode.
