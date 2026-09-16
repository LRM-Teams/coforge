# ADR 0019: Cache GitHub installations in the database, kept fresh by webhooks

Status: accepted
Date: 2026-09-16

## Context

`apps/web/src/features/integrations/github-settings.tsx` calls `getGitHubConnection`
on every mount of the Settings → Integrations section. Its server side,
`GitHubConnection.overview()` in
`apps/web/src/server/integrations/github-connection.server.ts`, made two *serial*
live calls to `api.github.com` (`GET /user`, then `GET /user/installations`,
paginated) while holding a Postgres advisory lock inside a transaction
(`GitHubConnection.locked`/`withToken`). CoForge's production server runs in
mainland China; round trips to `api.github.com` measure 0.5–8 s and sometimes
time out outright, so the Settings section routinely sat on "Loading
settings…" and occasionally surfaced an error, and a slow GitHub call held a
Postgres connection and an advisory lock for the duration.

GitHub's REST API best-practices documentation
(https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
recommends subscribing to webhook events instead of polling, and notes that
conditional requests (`If-None-Match` plus a `304` response) are a free,
fast alternative when a request cannot be avoided entirely. CoForge's GitHub
App already exists (App ID `4937758` in staging) and can emit `installation`,
`installation_repositories`, and `github_app_authorization` webhook events;
the last of these is enabled by default for GitHub Apps and requires no
additional GitHub-side configuration. Nothing before this record subscribed
to any of them — `infra/staging/README.md` explicitly said "Disable webhook
Active for now: this slice does not implement a webhook endpoint."

## Decision

1. **Settings reads only the database.** `GitHubConnection.overview(userId)`
   becomes a pure DB read with no GitHub I/O: no `GitHubConnection` row means
   `disconnected`; a row with `credentials === null` means `reauthorize`;
   otherwise `connected`, with installations read from a new
   `GitHubUserInstallation` table, and `pending_installation` when that table
   has zero usable (non-suspended) rows for the user.
2. **A new table, `GitHubUserInstallation`** (`github_user_installations`),
   caches one row per `(userId, installationId)`: `accountLogin`,
   `repositorySelection`, `suspended`, `configureUrl`, and `syncedAt`.
3. **`GitHubConnection.sync(userId)`** is the only method that still talks to
   GitHub for installations. It fetches `/user` and all pages of
   `/user/installations` concurrently (not serially, as `overview()` used
   to), verifies identity the same way `status()` already did, and replaces
   the user's cached rows in one transaction (delete rows for installations
   no longer returned, upsert the rest, stamp `syncedAt`). It runs: after a
   successful OAuth `complete()` (swallowing failures, since the connection
   itself is already saved); from a new `refreshGitHubConnection` server
   function that the Settings page calls in the background right after its
   instant DB-backed render, and that the manual "Refresh" button now calls
   directly; and inside `accessibleRepositories()` so create-project's live
   repository listing also refreshes the installation cache as a side
   effect.
4. **A webhook route**, `POST /api/integrations/github/webhook` →
   `githubWebhookHandler` (`github-http.server.ts`), verifies
   `X-Hub-Signature-256` (`sha256=<hex hmac-sha256 of the raw body>`) with
   `crypto.timingSafeEqual` over equal-length buffers, reading the raw body
   once via `request.text()` before any JSON parsing. A missing or invalid
   signature is `401`; an unconfigured webhook secret is `503`; every handled
   or ignored event type responds `204`, since GitHub retries non-2xx
   responses and there is nothing to gain by ever provoking a retry for a
   payload this handler is deliberately ignoring. `installation` (`deleted`,
   `suspend`/`unsuspend`, `created`/`new_permissions_accepted`),
   `installation_repositories`, and `github_app_authorization` (`revoked`)
   are handled in a pure, DB-only function, `applyGitHubWebhookEvent`
   (`github-webhook.server.ts`), independent of the signature check so each
   half is independently testable. A payload whose `installation.app_id`
   does not match this App's configured `appId` is ignored.
5. **The advisory lock no longer spans a GitHub read.** `withToken`'s
   transaction now only reads the stored token and performs a refresh-token
   exchange when the token is near expiry — that exchange is the one GitHub
   call that must stay serialized under the lock, so concurrent readers
   rotate an expired token exactly once. The wrapped `action` (the actual
   GitHub read) runs after the transaction commits. If `action` throws
   `GitHubUnauthorized` (a `401` from GitHub), a second short locked write
   clears `credentials`, but only if the row it re-reads still matches what
   the first transaction returned, so a refresh that raced in between is
   never wiped by a stale unauthorized result.
6. **Proactive refresh.** `overview()` fires `withToken` with a no-op action,
   un-awaited, whenever the cached token is within an hour of `expiresAt`
   and its `refreshExpiresAt` has not passed, throttled to once per user per
   process per minute. This keeps ordinary page loads off the refresh path
   without making them wait for it.
7. `COFORGE_GITHUB_WEBHOOK_SECRET` (and `_FILE`) is a new, optional
   `GitHubConfig` field, read through the same `secret()` helper as the
   other `COFORGE_GITHUB_*` secrets in `github-config.server.ts`. It is
   optional because existing deployments have no webhook configured yet;
   the webhook route alone returns `503` until an operator sets it, and the
   OAuth connect/reauthorize/disconnect flows are unaffected either way.

## Alternatives

- **ETag-conditional polling on every page load.** A `304` response is
  cheaper than a full payload, but Settings would still make a live round
  trip to `api.github.com` on every mount, on the same slow network path
  that motivated this change, and it does nothing for the two serial calls
  or the lock held across them.
- **Fix the immediate symptom by proxying the calls through a faster
  network path (e.g., a China-side egress proxy) without changing the data
  flow.** Rejected: Settings would still block on a live GitHub round trip
  per load, just a faster one; any proxy outage or GitHub-side slowness
  still surfaces as "Loading settings…" or an error, and the advisory lock
  is still held across it.
- **Cache installations in the TanStack Start route loader instead of the
  database.** A loader-level cache is per-request/per-process and has no
  invalidation path: it goes stale the moment a user uninstalls the App or
  an admin suspends an installation, with no signal to evict it, and it
  does not survive a server restart or a second replica.

## Consequences

- `apps/web/prisma/schema.prisma` gains `GitHubUserInstallation`
  (`github_user_installations`), migration
  `20260916140000_github_user_installations`.
- `apps/web/src/server/integrations/github-connection.server.ts`:
  `overview()` is DB-only; `sync()` is added; `withToken` is restructured
  per point 5; `disconnect()` also clears the installation cache;
  `accessibleRepositories()` takes its installation list from `sync()`.
- `apps/web/src/server/integrations/github-webhook.server.ts` (new):
  `verifyGitHubWebhookSignature` and `applyGitHubWebhookEvent`.
- `apps/web/src/server/integrations/github-http.server.ts` gains
  `githubWebhookHandler`; `apps/web/src/routes/api/integrations/github/webhook.ts`
  (new) wires it to `POST /api/integrations/github/webhook`.
- `apps/web/src/features/integrations/github.functions.ts` gains
  `refreshGitHubConnection`; `github-settings.tsx` renders the DB snapshot
  immediately, refreshes in the background without a spinner, and points its
  manual "Refresh" button at `refreshGitHubConnection`.
- `apps/web/src/server/integrations/github-config.server.ts` gains the
  optional `webhookSecret` field.
- `apps/web/test/github-connection.integration.ts` is extended; a new
  DB-free unit test, `apps/web/test/github-webhook-signature.test.ts`,
  covers `verifyGitHubWebhookSignature` directly.
- `infra/staging/README.md` documents the webhook URL, the events to enable
  and `COFORGE_GITHUB_WEBHOOK_SECRET`; `infra/staging/docker-compose.yml`,
  `scripts/deploy/remote-deploy.sh` and `.github/workflows/deploy-staging.yml`
  carry it the same optional way as `COFORGE_GITHUB_CLIENT_SECRET`.

## Validation

`bun run check` (repo root); `bun run --cwd apps/web build`
(regenerates `routeTree.gen.ts` for the new webhook route);
`GITHUB_TEST_DATABASE_URL=<local disposable Postgres> bun test
apps/web/test/github-connection.integration.ts`; `bun test
apps/web/test/github-webhook-signature.test.ts`.

Rollback is a follow-up CR reverting this record: `overview()` back to a
live GitHub read, deleting the webhook route and `GitHubUserInstallation`
migration. Because the webhook secret is optional and no code path requires
it to be set, disabling the webhook (or never configuring one) degrades
Settings back to relying solely on `sync()`'s background/manual refresh,
not to an error state.
