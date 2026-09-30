# Approved setup identity models

`User` is the internal business subject with a stable UUID and required unique
internal `username`. Public user targets are `@${User.username}`; provider
subjects are never usernames. A username is a readable handle, not something a
person types: it starts with a letter, is 3 to 32 characters of `a-z 0-9 _ -`
with no `-` or `_` at either end (`apps/web/src/lib/username-grammar.ts`).
On first identity creation `UsernameAllocator`
(`apps/web/src/server/auth/username-allocation.server.ts`) takes the first of
these that yields a usable name: the Authing `preferred_username`, the email
local part without a `+tag`, the ASCII slug of the profile name, the ASCII slug
of the nickname, and finally `user`. A name that starts with a digit gets the
prefix `u`; a name with a run of 11 or more digits, however spaced or
surrounded (it may be a phone number), and a reserved word are never used. A taken name gets the smallest free `-N`
(`N >= 2`); the unique index decides races, so the create is retried a bounded
number of times and ends with an 8-hex suffix. The username is not changed by
later logins. Accounts created before letter-first allocation keep their
existing names, some digit-first or ending in an 8-hex suffix, and stay valid
`@username` targets until they are renamed. `UserIdentity` maps
an external provider and subject to that User; provider subjects are never
business foreign keys. Membership, Agent ownership, and Computer ownership use
the internal User UUID. Existing rows are backfilled by the migration before
the legacy external column is removed. `User.email` is the latest email the
identity provider reported at login, nullable, not unique, not an identity key.
An account registered with a phone number alone has none and signs in like any
other; the signed session and every consumer of it treat the email as optional.

`User.fullName` is the name teammates see. It is nullable because an account
created before it has none until it is asked for one, and `null` means not yet
asked. A signed-in person with none is sent once to `/welcome` (a page outside
the Workspace layout), from sign-in, from `/w/<slug>`, from `/workspaces/new`
and from an invite link `/join/<token>`, but not from `/oauth/verify`. Sign-in
still issues the session, but creates nothing until they answer: submitting the
name saves it, then makes their personal Workspace, titled with it. A session
whose user row is gone is sent to sign in again instead. The name follows the
one rule for a person's name (`apps/web/src/features/profiles/person-name.ts`),
which the profile's own name shares: normalized and 1 to 80 characters, counted
as code points, and refused when it holds control, bidirectional or only
invisible characters, is the server's sender label `System`, or starts with `@`.
The first name saved stays: a second submit changes nothing and returns the
memberships as they are. The signed session's `name` is only what the provider
reported (its name, else its nickname), kept to start the name field (left empty
when it is a phone number or an email); it never labels anyone.
`User.displayName` is
an optional nickname that replaces the full name in labels when set. The
migration that added `fullName` copied every existing `displayName` there
and left `displayName` as it was, so an account that had already set a name
counts as named and its label does not change. A `displayName` equal to the
user's `username` (a value an old save froze into it) was not copied and was
cleared, which labels the same. A person with neither is named by
their username, without an `@`, until asked. The provider's name is not stored
and never labels a person.
`humanLabel` in `apps/web/src/lib/human-label.ts` is the one rule for that label,
in messages, member lists, mentions, reactions, notifications, and the
signed-in user's own shell. No screen shows a person's username, except the
`@` list beside two people whose label and description are identical, where
nothing else tells them apart. It is the handle Agents use in `@mentions` and the label of last resort, and a search
finds a person by it only when it is their label. The Workspace directory that
the Search page and the pickers load carries a person's label and full name,
never the username, and the Members directory lists people by label. An Agent's
`@handle` stays visible. Settings → Account edits `fullName` (required) and
`displayName` (optional, and blank means none), both by that one rule; a name it
refuses is worded inline where it is typed. A `displayName` equal to the
`fullName` is stored as none.

`User.description` stores the editable profile description. The optional
`avatarObjectKey` and `avatarContentType` identify the user's current private
avatar in the shared user-files store; image bytes and delivery URLs are never
stored in PostgreSQL. Replacing an avatar writes a new immutable object before
the row points to it, then removes the previous object. `Agent` uses the same
two columns for its own picture, in the same image store.

Setup persistence consists of `User`, `UserIdentity`, `Workspace`,
`WorkspaceMembership`, `Computer`, and `WorkspaceComputer`.
`WorkspaceMembership.role` is `owner`, `admin`, or `member`. The Workspace creator
is the immutable owner. `WorkspaceComputer`
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
