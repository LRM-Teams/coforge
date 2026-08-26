# coforge-computer instructions

These rules extend the repository root `AGENTS.md` for this app.

- Treat the compiled CLI as the public seam. Cover command help, arguments,
  stdout/stderr, and exit codes with tests before changing behavior.
- Use Commander for the command tree. Do not add parallel handwritten argument
  parsing.
- `login` authenticates the user, stores credentials in the OS credential
  store, and lists accessible Workspaces. It must not register a Computer,
  bind a Workspace, or start a workspace-daemon.
- `setup` creates or restores at most one Workspace–Computer binding. Its
  optional positional value is a stable `workspace-slug`; never add `--all`.
- Never print access tokens, refresh tokens, device codes, or stored secrets.
- Resolve state through the platform-native path module; do not hand-build a
  hidden home-directory convention at call sites.
- Run `mise run test:computer`, `mise run check:computer`, and
  `mise run build:computer` before review.
