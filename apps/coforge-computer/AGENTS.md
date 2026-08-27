# coforge-computer instructions

These rules extend the repository root `AGENTS.md` for this app.

- Treat the compiled CLI as the public seam. Cover command help, arguments,
  stdout/stderr, and exit codes with tests before changing behavior.
- Use Commander for the command tree. Do not add parallel handwritten argument
  parsing.
- `login` remains available for explicit re-authentication, but the normal
  user-facing flow is `setup`. When needed, setup performs OAuth login inside
  the same flow, uses a Workspace-page setup intent, registers the Computer,
  binds one Workspace, and starts the Daemon.
- Do not ask users to enter a Workspace ID/slug or select from a Workspace
  list. The setup intent identifies exactly one Workspace; binding another
  Workspace requires a new setup initiated from that Workspace's page.
- Computer has no long-lived cloud WebSocket. It communicates with Daemon over
  local RPC; each Daemon-supervised workspace worker owns its own cloud WSS
  connection and uses the versioned CoForge RPC/Protobuf protocol.
- User authorization may authorize the one-time Computer registration, but
  User credentials must not be persisted by Daemon or exposed to Agent
  runtimes. Daemon uses its Computer/Workspace credential after setup.
- Never print access tokens, refresh tokens, device codes, or stored secrets.
- Resolve state through the platform-native path module; do not hand-build a
  hidden home-directory convention at call sites.
- Run `mise run test:computer`, `mise run check:computer`, and
  `mise run build:computer` before review.
