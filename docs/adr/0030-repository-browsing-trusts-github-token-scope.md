# ADR 0030: Repository browsing relies on GitHub's token scope instead of re-enumerating access

Status: accepted
Date: 2026-09-17

## Context

`GitHubConnection.withVerifiedRepository()` guards `repositoryOverview()`: before any content read
it calls `sync()` (`/user` + `/user/installations`, then a transaction rewriting the User's
installation rows — see ADR 0019, GitHub installation cache), pages through every repository of
every usable installation, and reads `/repos/:fullName` to confirm the selected id and full name.
PR #294 reused it for the in-app file browser, so opening one file cost five to six serial GitHub
requests before the GraphQL read, and the page sat in a loading state for seconds per click.

That enumeration answers "may this User, through this App, read this repository?". GitHub answers
the same question on every request made with a GitHub App **user access token**: the token reaches
only resources the User can access, that the App has permission for, in an account where the App
is installed
([docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)).
A read of a repository outside that intersection fails at GitHub; CoForge never falls back to an
installation token or an anonymous request (`docs/architecture.md`).

This moves a security boundary, so it needed Frank's decision (root `AGENTS.md`, decision gates).
The design draft for PR #301 put the trade-off to Frank on 2026-09-17, first as a 60-second cache
of our own verdict and then, after checking GitHub's documentation, as the approach below with no
cache at all. Frank let the implementation proceed on that basis and merged PR #301. The code
review of #301 then noted the decision had been recorded only in `docs/architecture.md`; asked
whether to record it as an ADR, Frank agreed, and this record closes that gap.

## Decision

1. **Browse reads** (`repositoryTree`, `repositoryObject`, `repositoryDirectoryCommits`,
   `repositoryRaw`) go through `withRepository()`: a current user token and nothing else. They do
   not call `sync()` and do not enumerate installations or repositories.
2. **Identity is still checked on every read**, inside the read: GraphQL responses carry
   `repository.databaseId`, REST paths read `/repos/:fullName` first (`verifiedMetadata`). A full
   name that now points at a different repository is refused with `ACCESS_DENIED`.
3. **No verdict is cached.** The only cache is the recursive tree body, keyed by repository *and
   User*, and it is served only after GitHub answers `304` to that User's token on that request
   (GitHub derives ETags from the token as well as the content, github/docs#34689). Revoking the
   User's access or the App's installation takes effect on the next request.
4. **Everything that selects or links a repository keeps the full verification**
   (`accessibleRepositories`, Project create/update), and so does `repositoryOverview()` until it
   is changed by its own CR. Workspace scope is still enforced by project functions / the
   `ProjectFiles` service before `GitHubConnection` is called.

## Rejected alternatives

- **Cache the full verification for 60 seconds per User and repository.** Keeps the enumeration
  but opens a window in which revoked access still reads, and still pays the full cost once a
  minute while browsing.
- **Keep `/repos/:fullName` in front of every file read.** Two requests per click for a check
  the GraphQL response can carry itself.
- **Share one cached tree across Users.** Cannot revalidate: a 304 is only ever returned for the
  token that produced the ETag.

## Consequences

- One GitHub request per opened file; two (metadata + tree, the tree usually a 304) per visit.
- A public repository stays readable through a User's token after the App is uninstalled from its
  account; that content is public, and the Project link itself is still maintained by the
  installation webhooks of ADR 0019.
- The installation cache is no longer refreshed as a side effect of browsing. Webhooks and the
  Settings refresh remain its writers.

## Validation and rollback

`github-connection.integration.ts` pins the behaviour: browse reads never request `/user` or
`/user/installations*`, a file read is exactly one request, identity mismatches are refused, and
the tree cache revalidates per User. Rolling back is mechanical — route the four browse reads
through `withVerifiedRepository()` again; no data or schema depends on this decision.
