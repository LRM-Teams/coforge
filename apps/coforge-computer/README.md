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

The canonical Workspace command is `setup [workspace-slug]`. Each invocation
creates or restores at most one Workspace–Computer binding; omitting the slug
will open an interactive single-Workspace selector. The MVP does not provide
`--all`. Cloud binding and interactive selection remain unimplemented until
their reviewed protocol is available; the CLI reports that limitation instead
of inventing an endpoint.

The executable runs on Bun and uses [Commander.js](https://github.com/tj/commander.js)
for commands, arguments, validation, generated help, suggestions, and version
output. Commander 15 is ESM-only and explicitly supports Bun. `picocolors` adds
TTY-safe emphasis without changing redirected output.

Daemon state follows each operating system's normal per-user location:

| Platform | State directory                                        |
| -------- | ------------------------------------------------------ |
| Linux    | `$XDG_STATE_HOME/coforge`, or `~/.local/state/coforge` |
| macOS    | `~/Library/Application Support/Coforge`                |
| Windows  | `%LOCALAPPDATA%\Coforge`                               |

Credentials use `Bun.secrets`, which delegates to macOS Keychain, Linux
libsecret, or Windows Credential Manager. This keeps tokens out of repository
files and plaintext application state. The trade-off is that Linux requires a
running Secret Service; when the native store is locked or unavailable, login
returns `AUTH_CREDENTIAL_STORE_UNAVAILABLE` with a remediation hint instead of
falling back to plaintext. Credentials never appear in command arguments,
stdout, stderr, or generated artifacts.

Stable `machine_id` issuance and its cloud registration payload remain pending
the architecture's device identity ADR and are not guessed here.

Official references:

- [OAuth 2.0 Device Authorization Grant (RFC 8628)](https://www.rfc-editor.org/rfc/rfc8628)
- [OAuth 2.0 Authorization Server Metadata (RFC 8414)](https://www.rfc-editor.org/rfc/rfc8414)
- [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/0.8/)
- [Apple application support directory](https://developer.apple.com/documentation/foundation/url/applicationsupportdirectory)
- [Windows `FOLDERID_LocalAppData`](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid)
- [Bun single-file executables](https://bun.sh/docs/bundler/executables)
- [Bun native credential storage](https://bun.sh/docs/runtime/secrets)
