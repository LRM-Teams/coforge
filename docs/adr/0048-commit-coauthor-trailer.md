# ADR 0048: Commit co-author trailer for Agent git commits

Status: accepted
Date: 2026-09-18
Approved by: Frank on 2026-09-18

## Context

CoForge Agents (Claude Code, Codex, Kiro, Pi, Cursor, the built-in CoForge Agent) run on a user's
Computer through the Daemon and can commit to a repository using the owner's own short-lived
GitHub credential (ADR 0020). ADR 0020 left "commit author, signing key, and explicit CoForge
provenance" as separate work; this ADR is that work for provenance. The human Agent owner stays
the git author - that boundary is unchanged - but a commit an Agent made carries no marker that
CoForge was involved.

Community practice for AI coding tools already answers this the same way. Amp adds a
`Co-authored-by: Amp` trailer plus an `Amp-Thread-ID` trailer
([docs](https://ampcode.com/docs/github)). Claude Code has an `attribution` setting that adds a
similar trailer. Cursor adds a `Co-authored-by: Cursor` trailer with a setting to turn it off. All
three write the trailer with tooling, not a model instruction, and default it on with an escape
hatch. GitHub documents the trailer format itself for any multi-author commit
([creating a commit with multiple authors](https://docs.github.com/en/pull-requests/committing-changes-to-your-project/creating-and-editing-commits/creating-a-commit-with-multiple-authors)),
including the `<bot-id>+<login>@users.noreply.github.com` form GitHub Apps' own bot accounts use.
Raft Computer has no commit identity or trailer code at all, so there is nothing to align with
here (Frank's explicit call: follow community practice, not "Raft has none so CoForge has none").

## Decision

An Agent's plain git commit to a repository gets one trailer:
`Co-authored-by: <slug>[bot] <<bot user id>+<slug>[bot]@users.noreply.github.com>`, where `<slug>`
and the bot user id identify the CoForge GitHub App's own bot account for the deployment
environment (staging: `coforge-staging[bot]`, user id `328977087`, App id `4937758`; production:
not yet registered as of this ADR). The human Agent owner remains the sole `Author`/`Committer`.

**Written by tooling, at commit time, never by the model.** The trailer is added by a
`prepare-commit-msg` git hook the Daemon injects into every Agent process's environment
(`packages/daemon/src/code-agent/environment.ts`), the same environment channel ADR 0020 already
uses for the GitHub credential helper (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`).
No prompt instruction asks any Agent to add it, and no provider's shell tool is rewritten to
inject it - see Rejected alternatives.

**Two injection paths, chosen by probing the Agent's own `git --version` once per launch (cached
per resolved git executable path; a missing `git` injects nothing).** The Daemon resolves the plan in
`AgentProcessManager.start`, the one seam every provider launches through, and hands it to the
provider as `AgentSessionOptions.gitHooks`; providers only forward it to `agentEnvironment`.

- **git >= 2.54** (April 2026 added config-based hooks): inject
  `hook.coforge-commit-trailers.event = prepare-commit-msg` and
  `hook.coforge-commit-trailers.command = coforge git prepare-commit-msg` as two more
  `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` entries. Config hooks run alongside the repository's own
  hooks (hookdir, `core.hooksPath`, husky, lefthook, ...) without touching `core.hooksPath` at all,
  including on `--no-verify` (verified).
- **git < 2.54** (Ubuntu 24.04 ships 2.43; a staging Linux Computer measured 2.43): inject
  `core.hooksPath` pointed at a Daemon-owned shim directory
  (`packages/daemon/src/code-agent/git-hook-shims.ts`), plus `COFORGE_GIT_CONFIG_BASE_COUNT`
  holding the `GIT_CONFIG_COUNT` value from *before* this function's own entries (the credential
  helper's included) were appended. The shim directory holds one POSIX `sh` script per client-side
  git hook name (githooks(5)) plus the server-side names, harmless on a client repository. Every
  shim resolves `GIT_CONFIG_COUNT=$COFORGE_GIT_CONFIG_BASE_COUNT git rev-parse --git-path hooks`
  (verified: this strips CoForge's own config entries, including its `core.hooksPath` override,
  and reports the repository's real hooks directory - its `.git/hooks`, or a repo-local override
  such as husky's `.husky/_`, relative to the worktree root where hooks run) and `exec`s that
  repository hook with `"$@"` if it is executable, preserving stdin (needed for `pre-push`); if
  the resolution is the shim directory itself, it exits rather than recursing. The `prepare-commit-
  msg` shim additionally runs `coforge git prepare-commit-msg "$@"` first, ignoring its exit
  status, before forwarding. The Daemon writes this directory once per process (idempotent,
  content-hash-named, mode 0700, under its own state directory next to `credentials/` - see
  `credential-store.ts`'s identical `COFORGE_DAEMON_HOME` convention), so a Daemon upgrade that
  changes shim content never clobbers a shim directory an already-launched Agent resolved
  `core.hooksPath` to.

**`coforge git prepare-commit-msg <msgfile> [source] [sha]`** (new command, `packages/coforge`):
skips silently (exit 0, no output) for a merge/squash commit message, and for any commit the
sequencer is replaying - `git rev-parse --git-path rebase-merge`/`rebase-apply` or
`CHERRY_PICK_HEAD` present (verified: plain `git rebase` and `git cherry-pick` fire
`prepare-commit-msg` with `source=message`, and without this skip every replayed commit - not
just the Agent's own - would gain the trailer). Every other commit gets it: plain, `--amend`
(`source=commit`), revert, `-m`, an editor commit, `--no-verify`. It reads `git remote get-url
origin`, parses `owner/repo` for a github.com remote (https, SCP-like, `ssh://`), and asks the
server for trailers over a new wire operation - the command never decides the trailer content
itself (no CLI-side shortcuts). Each returned trailer is applied with `git interpret-trailers
--in-place --if-exists addIfDifferent`, so amending an already-trailered commit never duplicates
the line. Any failure anywhere in this path - proxy unreachable, server error, git failure - is
exactly one stderr line in plain words (`coforge: CoForge co-author trailer skipped: <reason>`)
and exit 0: a nonzero `prepare-commit-msg` aborts the Agent's commit, and a skipped trailer must
never do that.

**Server decides, per Project.** `POST /api/agent/v1/github-commit-trailers`, body
`{ repository: string | null }` -> `{ trailers: string[] }`, wired end to end exactly like
`github-credentials` (SDK route table, daemon Agent proxy, `DaemonConnection`, `DaemonRuntime`,
the `coforge` CLI transport, and an Agent-authenticated web route). The server finds the Project in
the Agent's Workspace whose `githubFullName` matches `repository` case-insensitively; if found and
its `commitCoAuthor` toggle (Prisma `Project.commitCoAuthor Boolean @default(true)`) is off, it
answers no trailers. Otherwise - including a repository not bound to any Project, or no remote at
all - it answers the trailer above when the App's bot identity is configured
(`COFORGE_GITHUB_APP_BOT_USER_ID`, a new non-secret env var alongside the existing
`COFORGE_GITHUB_APP_SLUG`), and none when it is not. `commitCoAuthor` uses the same
edit-project-settings permission every other Project setting already uses; this repository does
not yet role-gate Project settings more narrowly, so this ADR does not introduce a new
authorization boundary. The toggle is visible in Project settings as "Add CoForge as co-author"
with a one-line hint.

## Rejected alternatives

- **A prompt instruction telling the Agent to add the trailer.** Unreliable across providers: some
  compact their own system prompt, some paraphrase instructions in their own commit-message
  generation, and none can be forced to run a fixed git command exactly as written. Amp, Claude
  Code, and Cursor all write their own trailer with tooling rather than a prompt instruction (see
  Context), which is the pattern this ADR follows.
- **Rewriting `git commit` inside the Agent's own shell tool**, as Amp's CLI does (its Bash tool
  rewrites a `git commit` invocation to add `-c trailer.*` and `--trailer` flags). CoForge does not
  own any provider's shell tool - Claude Code, Codex, Kiro, Pi, and Cursor each run their own,
  outside CoForge's control - so this only works for a Daemon-owned Agent implementation, not the
  general case this feature needs.
- **A `git` wrapper earlier in the Agent's `PATH`.** Every git invocation (status, diff, log, ...)
  would pay a process start for a wrapper that does nothing on all but one subcommand, and a
  faithful argument-forwarding wrapper is awkward on Windows (`.cmd`/`.exe` shim semantics differ
  from POSIX `exec`). A hook only runs when git itself decides to run it.
- **Plain `core.hooksPath` injection without the forwarding shim.** `core.hooksPath` replaces the
  repository's whole hooks directory; pointing it straight at a CoForge-only directory would
  silently disable every repository hook (pre-commit linters, husky, lefthook, CI-adjacent
  checks) for the life of the Agent process. Rejected outright, which is why the shim directory
  forwards to the repository's real hooks - see Decision.

## Consequences and migration

`COFORGE_GIT_CONFIG_BASE_COUNT` joins `environment.ts`'s existing protected-key list: an Agent's
own inherited environment or user-configured `envVars`/adapter `extraEnv` can never spoof it,
matching every other Daemon-authored identity value in that list. The Prisma migration is additive
(`commitCoAuthor Boolean @default(true)`); no backfill needed. Unset `COFORGE_GITHUB_APP_BOT_USER_ID`
(true today for the production App, not yet registered) makes the feature a no-op - the wire
operation still answers `{ trailers: [] }` rather than erroring.

## Validation and rollback

Tests cover: the shim's real-git forwarding (hookdir, husky-style repo-local `core.hooksPath`,
`pre-push` stdin, no self-recursion, a repository with no hook of that name); the version probe's
branching and per-path caching; `environment.ts`'s `GIT_CONFIG_*`/`COFORGE_GIT_CONFIG_BASE_COUNT`
injection and protected-key clearing; `coforge git prepare-commit-msg`'s skip rules (merge, squash,
rebase, cherry-pick), remote-URL parsing, no-duplicate-on-amend, and a real (unmocked) proxy
failure still exiting 0 with one stderr line; the wire operation's project-toggle-off, unbound-
repository, and unconfigured-bot-identity cases. Repository `test`, `check`, and `build` gates
remain required.

Rollback removes the hook injection (both paths), the `coforge git prepare-commit-msg` command, the
wire operation and its route wiring, the Project toggle and its column (a reversible migration), and
this ADR's config vars. No existing commit history needs cleanup - the trailer is inert text in
past commit messages, not a system CoForge depends on reading back.
