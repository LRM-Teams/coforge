# ADR 0020: Give Agents the owner's short-lived GitHub App user credential

Status: accepted
Date: 2026-09-16
Approved by: Frank on 2026-09-16

## Context

Code Agents need authenticated Git and GitHub CLI access. A personal GitHub Connection already
stores refreshable, expiring GitHub App user authorization for repository discovery. GitHub limits
that user token to the intersection of the user's own access, the App installation's repository
grant, and the App's permissions.

Amp uses this credential model: Git and `gh` act as the user, obtain a current credential on demand,
and do not persist it in the execution environment. This preserves the responsible GitHub actor on
pushes and pull requests. An App installation token would instead attribute operations to the App
bot and would require a separate App private-key lifecycle.

Official sources:

- [Amp GitHub integration](https://ampcode.com/docs/github)
- [GitHub App user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- [Repositories accessible to a user access token](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-user-access-token)
- [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)

## Decision

The Agent owner is the GitHub actor. For each Git credential lookup or `gh` invocation, the bundled
Agent-facing launcher requests that owner's current GitHub App user token through the Daemon-owned
Credential Proxy and Agent-authenticated HTTPS endpoint. Web/backend refreshes the encrypted token
under its existing per-user database lock and returns it with `Cache-Control: no-store`.

The token is never written to disk, command arguments, logs, or snapshots. Git receives it through
the credential-helper protocol and ignores `store` and `erase`; `gh` receives it only as `GH_TOKEN`
in the child process environment. The helper answers only well-formed HTTPS `github.com/owner/repo`
requests. Agent Git configuration rewrites GitHub SCP-like and SSH URLs to HTTPS.

The credential can reach any repository in the user's GitHub Connection intersection, not only the
repository bound to the current CoForge Project. This matches Amp and GitHub's own authorization
boundary. CoForge does not mint one App or credential per Agent.

Installation and update links carry a random browser-bound `state`. Because user authorization
during installation is enabled, GitHub returns to the existing user authorization callback instead
of a Setup URL. CoForge validates the installation state, ignores the untrusted returned installation
ID, and syncs installations through the authenticated user token. Redirect on update remains disabled
because GitHub ignores it without a Setup URL. Later repository-access changes are consumed through
GitHub webhooks and refreshed through the user token when Settings or the Project selector loads.

## Alternatives

- **Repository-scoped installation token:** rejected because GitHub attributes work to the App bot,
  obscuring the responsible user, and CoForge would need to store and rotate an App private key.
- **One GitHub App per Agent:** rejected because App registration, installation, and key lifecycle
  would scale with Agent count without creating a useful human responsibility trail.
- **SSH deploy keys:** rejected because each repository needs separate provisioning and pushes are
  not attributed to the connected user.

## Consequences and migration

The App requests only the repository and organization permissions needed by supported Agent GitHub
operations; installation owners still choose repositories. Existing users may need to approve new
permissions. The previous `COFORGE_GITHUB_PRIVATE_KEY` deployment secret is removed.

The host must have the GitHub CLI installed for `gh` commands. CoForge installs a launcher earlier in
the Agent `PATH`; that launcher finds the host binary outside its own immutable version directory to
avoid recursion. Commit author and signing key remain separate work; explicit CoForge provenance is
[ADR 0048](0048-commit-coauthor-trailer.md), which reuses this ADR's environment-injection channel
for a `Co-authored-by` trailer without changing the commit author decided here.

## Validation and rollback

Tests cover user-token issuance and expiry, authenticated HTTPS forwarding, Proxy input rejection,
credential-helper host/path filtering, SSH URL rewriting, `gh` token injection and recursion
avoidance, launcher integrity, and installation-state comparison. Repository `test`, `check`, and
`build` gates remain required.

Rollback removes the launchers, Git configuration, credential endpoint, and installation callback handling.
Personal repository discovery and existing Project bindings remain unaffected; no schema or token
migration needs cleanup.
