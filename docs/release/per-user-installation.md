# Per-user installation

Installation, upgrade, background startup, and rollback run entirely as the
current user. They must not request `sudo` or administrator elevation, write to
`/usr/local`, `/opt`, `/Library`, `Program Files`, or system service locations,
reuse another user's installation, enable Linux lingering, or modify root-owned
or system-level service configuration.

Configuration, credentials, version storage, and logs live below the current
user's `~/.coforge`, split into `computer` and `daemon` roots. The one exception
is the `coforge-computer` shim, which is the single installed path that has to
be on PATH and therefore cannot live in a private directory nobody's PATH names:

- Linux and macOS place the shim in the XDG user binary directory - `XDG_BIN_HOME`
  when it is set to an absolute path, otherwise `~/.local/bin`. That directory is
  already on PATH for most users, so an install is usable in the shell that ran
  the installer, and `install.sh` writes shell configuration only when the
  directory is genuinely absent from PATH. The shim itself is only a symlink into
  the versioned installation below `~/.coforge`, so upgrade and rollback move the
  `active` link and never touch the user's PATH. Computer background startup is
  user-scoped; only Computer may register a per-user LaunchAgent on macOS.
- Windows has no comparable per-user PATH convention, so the shim - a `.cmd`
  launcher rather than a symlink - stays in `~/.coforge/computer/bin`, and
  `install.ps1` puts that directory on PATH instead. It prepends the directory to
  the current user's `Path` under `HKCU\Environment`, never the machine scope,
  which would require elevation. The value is read with
  `DoNotExpandEnvironmentNames` and written back as `ExpandString` rather than
  through `[Environment]::SetEnvironmentVariable(..., "User")`, which would
  flatten a user's `%USERPROFILE%`-style entries into today's expansion. The
  script then also prepends the directory to `$env:Path`, which reaches the
  session that ran it because the documented entry point (`irm ... | iex`)
  executes in the user's own process rather than a child - so, as on Linux and
  macOS, a Windows install is usable immediately. For the same reason the script
  must never call a top-level `exit`, which would terminate the user's session.
  No `WM_SETTINGCHANGE` broadcast is sent: consoles read the registry at launch,
  so only already-running Explorer-spawned applications miss the change. Only
  Computer may use a current-user startup mechanism.

The installer maintains a user-owned versioned installation directory. It downloads
the unified Computer executable into staging, verifies it against the
manifest's recorded size and SHA-256 checksum, activates only after it passes,
preserves the prior version for rollback, and never relocates
stable machine identity, credentials, configuration, or user data into a
versioned directory. Only the `coforge-computer` shim enters the current
user's PATH. Computer launches the adjacent executable with `__daemon` through
the exact path selected by the active version; no standalone Daemon payload or
service entry is installed.

Installation also writes a tiny version-local `coforge` launcher which invokes
that directory's `coforge-computer __agent-cli`. Daemon prepends its own
executable directory to Agent PATH. The Agent CLI implementation remains in
`packages/coforge`, compiled into the unified executable; its internal entry does not initialize
logging, sockets, cloud connections or Workspace recovery. Users continue to
run only Computer management commands; Agents execute `coforge`.
This adds neither a third native payload nor a Bun/npm requirement. The
launcher is covered by the installed version's offline integrity check and
does not follow a later active-version switch underneath an existing Daemon.
The installer supplies this launcher; Daemon startup does not repair older
installations. No older-client or older-installer compatibility is maintained.
Installer identity metadata (`installation.json`) now uses schema 4 and
records the `computer` identity, the generated `agentCli` and `githubCli`
launcher identities, and the installed `photon_rs_bg.wasm` identity. It
contains no Daemon identity. Schemas 2 and 3 remain valid only as offline
rollback targets for versions installed before `githubCli`/`photonWasm`
existed; `#assertInstalled` checks each field only for the schema that
introduced it, with no fallback for a version installed from here on.

Previously published rc1 through rc3 remain immutable. They are not rewritten
with a newer schema and receive no raw-artifact or two-payload fallback.
Crossing from their layout requires a fresh bootstrap install; the old
updater is not assumed to accept a newer manifest schema. Existing
installations remain rollbackable to
their own retained bytes, but rollback does not translate between layouts.

Normal CLI lifecycle commands are one-shot local RPC clients. They start or
reuse the native per-user process manager and never detach an unmanaged
fallback. Environments without that manager, including containers, must run
`coforge-computer foreground` under an explicit external supervisor. That mode
does not transfer process ownership to the CLI and is not silently selected.

Both `install.sh` and `install.ps1` expose two selection modes with identical
semantics:

- omitted or `--version latest` resolves the feed's `latest` pointer;
- `--version <version>` selects one exact published version.

An exact version is enough to select an installation because it identifies the
complete unified executable; there is no independent Daemon version.

Staging and production artifacts are **not interchangeable**. The feed a build
trusts is compiled into it (`COFORGE_RELEASE_FEED_URL`, see
`packages/computer/src/release-channel.ts`), so a binary built for staging carries
the staging feed address and would keep updating itself from staging if it were
copied into the production feed. Promotion therefore rebuilds the same commit
against the production feed rather than copying bytes; what carries across
environments is the commit and the test evidence, not the artifact.

The same build selection fixes the business server: `releases-staging.coforge.cn`
maps to `https://staging.coforge.cn`, and `releases.coforge.cn` maps to
`https://coforge.cn`. Release compilation gives the bundled Daemon that same
server. Login, setup, and Daemon recovery do not offer a public `--server` or
runtime server override. Existing cross-environment configuration fails rather
than redirecting credentials. Private E2E fixture builds inject local transports
at module boundaries; they are not distributable release artifacts.

For the running local E2E stack, execute:

```sh
COFORGE_E2E_ALLOW_DEVICE_AUTH=1 \
COFORGE_E2E_WEB_URL=http://localhost:8789 \
COFORGE_E2E_WORKSPACE_SLUG=dev-user \
mise exec -- bun test ./scripts/e2e/computer-environment.e2e.ts
```

This compiles private local fixtures and the production Daemon, exercises setup
against Web/PostgreSQL/Redis/Centrifugo, checks the registered Computer's exact
online status, and rejects wrong-environment or legacy Daemon state/peers with
no Computer profile. OAuth uses the development provider. This is not evidence
of macOS launchd behavior, staging Authing login, or a published artifact's
installation on a real Mac; those remain separate release acceptance checks.

The POSIX bootstrap persists PATH setup for Bash, Zsh, or Fish without elevation
or replacing existing configuration. It prints the command needed in the current
shell (a piped installer cannot modify its parent shell) and an absolute setup
command. Metadata requests are quiet; only the binary download has a progress bar.

`install.sh` and `install.ps1` read the same `COFORGE_RELEASE_FEED_URL`
variable, but unconditionally and at runtime: any `https://` value is
accepted, not just the compiled-in default. This is deliberate, not an
oversight of the rule above: `release-channel.ts` hardens the _compiled_,
long-lived binary that auto-updates itself indefinitely, where a runtime
toggle would let it be silently redirected to an untrusted feed on every
future update. The bootstrap scripts are the opposite shape - a one-shot the
user explicitly runs (`curl … | sh` / `irm … | iex`) from a command they can
read before running it - and anyone able to set this variable in that same
invoking shell can equally set `PATH` or a proxy variable to redirect the
script's requests, so restricting the variable here would not remove an
attacker capability, only a legitimate one it may be used for: pointing a
manual or scripted install at a non-default feed (a staging or private feed).
No such use is implemented or documented today - `installCommands()` in
`apps/web/src/features/install/install-commands.ts` renders a plain
`{origin}/computer/install.sh`, not a feed URL, and `apps/web` now serves that
path with the exact bytes of `scripts/release/install.sh` (embedded at build
time; see `apps/web/src/server/install/install-script.server.ts`) unchanged -
the same script, with the same compiled-in `https://releases.coforge.cn`
default, is served from every deployment. How a staging deployment's served
copy of `install.sh` would reach the staging feed _by default_ (as opposed to
a caller exporting the variable by hand) therefore remains unresolved and
belongs to a future per-environment publishing/serving decision, not to this
variable. Both scripts carry the threat-model half of this reasoning inline
as a comment.
