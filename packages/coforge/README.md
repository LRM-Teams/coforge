# `coforge` Agent-facing CLI

This binary is the stable command boundary exposed to code agents. Message
transport is intentionally injected by the eventual host; the standalone
binary currently reports a clear unavailable-transport error.

`coforge inbox check` returns a local, non-consuming union of pending
`message_target` attention and typed `app` items. It never performs a cloud
Message read, clears Message attention, or acknowledges an App item.
The generic Inbox CLI does not expose acknowledgement. Each App owns any
completion command and concurrency token required by its domain.

`coforge message check` drains the server-side pending events for the Agent:
the server returns a bounded page of unread messages and advances the Agent's
read position on the server as part of that same request. When more messages
remain, the CLI ends its output telling the Agent to run `message check`
again instead of reporting no more new messages; run it again to keep
draining until it reports no new messages.

Before `message send`, Web/backend may return `sideEffectDecision: "hold"` with
canonical `messages` instead of pretending the send succeeded. The daemon keeps
only the draft body and Web/backend's opaque hold token. After consuming that
context, retry the preserved body with `message send --send-draft`. Agents never
see or supply tokens or sequence numbers. A retry always repeats the exact target with
`message send --target "@user" --send-draft`. `--anyway` requests a server-authorized
bypass, is valid only with `--send-draft`, and is rejected until Web/backend has
issued a second consecutive hold. A successful send consumes the held state.

`coforge message read --target "@user"` reads history with a default limit of
50 (maximum 100). Continue with opaque message-id cursors via `--before`,
`--after`, or `--around`; these options are mutually exclusive. Sequence
numbers are server-internal and are never supplied by an Agent.

`coforge message resolve <message-id>` looks up one message by its full UUID
or an unambiguous 8-hex prefix across every conversation the Agent belongs to,
and prints it in the same `[target=... msg=... time=...] @sender: body` line
`message check` uses. It never requires the Agent to know the message's
target. `coforge message react --message-id <id> --emoji <emoji> [--remove]`
adds (or, with `--remove`, removes) the Agent's own reaction; the emoji must
be one to sixteen characters with no whitespace. Both operations are
idempotent: reacting twice with the same emoji, or removing a reaction that
is not present, still succeeds.

Pass `--reviewer-isolation` on `message send`, `task claim`, `task update`, or
`task amend` (or set `COFORGE_REVIEWER_ISOLATION=1`/`true`, accepted
alongside `0`/`false`) when a reviewer agent must act without seeing newer
conversation context. The flag requests `freshnessContextMode: "withheld"`
from the server. If the action is held on a freshness check, the CLI prints
only the count of withheld messages — never their bodies — as
`Reviewer-isolation freshness hold: N newer message(s) withheld.`, and any
other transport failure is reported generically (upstream detail withheld)
rather than surfacing the server's response text.

`coforge weekly-report context|list|read` is the weekly-report assistant's
authorized on-demand read surface. It reuses the Credential Proxy and Agent
HTTPS API. Context is a compact page manifest, list is cursor-bounded, and
read is one named section with a character cap. Ordinary Agents are denied.
