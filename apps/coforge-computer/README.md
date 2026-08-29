# coforge-computer

`coforge-computer` is the machine-level daemon that installs, upgrades, and
supervises `coforge-daemon`. The current vertical slice implements interactive
login with the OAuth 2.0 device authorization grant:

```bash
mise exec -- bun run apps/coforge-computer/src/cli.ts login --server https://coforge.example
```

The command discovers `device_authorization_endpoint`, `token_endpoint`, and
the CoForge `coforge_workspaces_endpoint` extension from the server's RFC 8414
metadata. It prints the verification URL and user code, polls according to RFC
8628 (including `authorization_pending` and `slow_down`), saves the credential
without printing it, and returns the Workspaces the user can access. Login does
not bind a Workspace or start a workspace-daemon.

Use `--json` for automation. Stdout contains exactly one JSON object; progress
and device authorization instructions use stderr. Success includes
`server_url`, `workspaces`, `binding_created: false`, and
`daemon_started: false`. Failures include a stable error `code`, a safe
`message`, and an actionable `hint`, and exit nonzero.

The metadata extension is an HTTPS endpoint. The Computer performs an
authenticated `GET` with the device grant's bearer credential and expects:

```json
{
  "workspaces": [{ "id": "ws_01", "slug": "example", "name": "Example" }]
}
```

The canonical flow is setup launched by a Workspace page setup intent (deep
link or installer parameter). Computer never lists or asks the user to choose a
Workspace. If no login credential exists, setup performs the OAuth device flow
inline, then registers the Computer through the CoForge RPC transport.

Computer stores one active registration only. Switching Workspace first stops
the daemon and its Agent runtimes/WSS, then durably replaces the local binding;
failures retain the old binding. The config contains only the stable
`workspace_id`. `setup --json`
keeps stdout to one stable result object and sends interactive prompts to
stderr. Setup registers the Computer and creates the server-side Workspace–Computer
registration through the approved CoForge RPC flow, then automatically starts (or reuses)
the local Daemon after a Unix Socket handshake. The current Daemon slice accepts
the handshake; Workspace worker supervision and the cloud RPC handler are still
separate implementation slices. The user does not run `coforge-daemon` separately.
Computer does not maintain a cloud WebSocket; each Workspace worker owns its own
cloud WSS connection.

Use `coforge-computer start` to start or reuse the user-managed Daemon and
configure every registered Workspace Worker. Use `coforge-computer stop` to
stop that Daemon and, with it, all of its Workspace Workers. Use
`coforge-computer restart` to perform both operations in order.

Use `coforge-computer logs` to print existing Computer log files and follow
new log records in real time. Press `Ctrl-C` to exit.

`coforge-computer install` and `upgrade` select `production.current` (`latest`),
`test.current`, or one exact `sha256:` release set. `rollback` reactivates the
retained previous bundle offline after checking both process payloads. All
versions and the sole Computer shim are installed for the current user; Daemon
is never exposed as a separate installed command.

The executable runs on Bun and uses [Commander.js](https://github.com/tj/commander.js)
for commands, arguments, validation, generated help, suggestions, and version
output. Commander 15 is ESM-only and explicitly supports Bun. `picocolors` adds
TTY-safe emphasis without changing redirected output.

Computer and Daemon data use separate directories under the user's home
directory:

| Platform | Computer directory                |
| -------- | --------------------------------- |
| Linux    | `~/.coforge/computer`             |
| macOS    | `~/.coforge/computer`             |
| Windows  | `%USERPROFILE%\.coforge\computer` |

Daemon data remains separate:

| Platform | Daemon directory                |
| -------- | ------------------------------- |
| Linux    | `~/.coforge/daemon`             |
| macOS    | `~/.coforge/daemon`             |
| Windows  | `%USERPROFILE%\.coforge\daemon` |

Credentials use `Bun.secrets`, which delegates to macOS Keychain, Linux
libsecret, or Windows Credential Manager. This keeps tokens out of repository
files and plaintext application state. The trade-off is that Linux requires a
running Secret Service; when the native store is locked or unavailable, login
returns `AUTH_CREDENTIAL_STORE_UNAVAILABLE` with a remediation hint instead of
falling back to plaintext. Credentials never appear in command arguments,
stdout, stderr, or generated artifacts.

Stable `machine_id` issuance and the initial cloud registration payload are
implemented in the Computer setup slice. Server-side validation and identity
proof remain pending.

Official references:

- [OAuth 2.0 Device Authorization Grant (RFC 8628)](https://www.rfc-editor.org/rfc/rfc8628)
- [OAuth 2.0 Authorization Server Metadata (RFC 8414)](https://www.rfc-editor.org/rfc/rfc8414)
- [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/0.8/)
- [Apple application support directory](https://developer.apple.com/documentation/foundation/url/applicationsupportdirectory)
- [Windows `FOLDERID_LocalAppData`](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid)
- [Bun single-file executables](https://bun.sh/docs/bundler/executables)
- [Bun native credential storage](https://bun.sh/docs/runtime/secrets)
