# Approved setup identity models

`User` is the internal business subject with a stable UUID and required unique
internal `username`. Public user targets are `@${User.username}`; provider
subjects are never usernames. Existing users are deterministically backfilled
as `user-` plus the full hyphenless UUID. On first identity creation a valid
Authing `preferred_username` is preferred; otherwise the backend derives a
normalized email local-part with a stable suffix from the already-generated
User UUID. The username is not changed by later logins. `UserIdentity` maps
an external provider and subject to that User; provider subjects are never
business foreign keys. Membership, Agent ownership, and Computer ownership use
the internal User UUID. Existing rows are backfilled by the migration before
the legacy external column is removed.

`User.displayName` stores the user's optional editable name override; when it
is null, the application displays the current identity-provider name.
`User.description` stores the editable profile description. The optional
`avatarObjectKey` and `avatarContentType` identify the user's current private
avatar in the shared user-files store; image bytes and delivery URLs are never
stored in PostgreSQL. Replacing an avatar writes a new immutable object before
the row points to it, then removes the previous object. `Agent` uses the same
two columns for its own picture, in the same image store.

Setup persistence consists of `User`, `UserIdentity`, `Workspace`,
`WorkspaceMembership`, `WorkspaceInvitation`, `Computer`, and `WorkspaceComputer`.
`WorkspaceMembership.role` is `owner`, `admin`, or `member`. The Workspace creator
is the immutable owner. `WorkspaceInvitation` stores pending invites by existing
User id for `admin` or `member` only. `WorkspaceComputer`
is the durable binding and contains the workspace/computer foreign keys. Its
database `id` is an internal storage primary key; the business identity is the
composite `(workspaceId, computerId)` key. That unique constraint makes
repeated setup converge on the same binding. `DaemonApiKey` stores only the
hash of the long-lived, revocable Daemon API key and its Workspace/Computer
binding; the plaintext key is returned once and persisted only in the native
credential store.

`AgentApiKey` stores only the SHA-256 `apiKeyHash` plus its Agent, Workspace,
owner, and Computer binding; plaintext `sk_agent_...` values are returned once
and never persisted. Key creation locks the owning Agent row with PostgreSQL
`FOR UPDATE`, revokes all active keys for that Agent, and inserts the replacement
inside one transaction. Exact-key revocation remains idempotent.

The repository must use database `upsert` operations and explicit unique-conflict
handling, never placeholder UUID rows. Concurrent requests may both reach the
upserts, but PostgreSQL uniqueness ensures one Computer and one
WorkspaceComputer binding; a deployment with stronger all-or-nothing behavior
may wrap the operations in a transaction. Token issuance occurs after the
durable binding is found or created, so an API-key creation failure is safely
retryable.
