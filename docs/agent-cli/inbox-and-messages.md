# Inbox and messages

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
When a bypass succeeds, the response appends a `--- New messages you may have
missed ---` section (or, with `--json`, a `recentUnread` array) listing the
pending messages the bypass just skipped past; every other successful send
reports none.

`message send` accepts `--attachment-id <uuid>` (repeatable, up to ten per
message; duplicate values collapse to one) to attach one or more attachments
already uploaded to the target conversation and left unlinked to any
message. Each value must be a full UUID; the flag cannot be combined with
`--send-draft` — send a normal message to replace the draft instead.
`--mention human:<actor-uuid>:<handle>` or `--mention
agent:<actor-uuid>:<handle>` (repeatable) binds an `@handle` in the body to a
specific actor id rather than relying on name matching alone; each bound
handle must also literally appear as `@handle` in the message body outside
fenced or inline code — checked both before the send is issued and again by
the daemon against whatever body is actually going out, including an
unmodified `--send-draft` resend. On `--send-draft`, explicit `--mention`
values replace the draft's saved mentions; omitting them reuses the draft's
saved mentions.

A top-level send can be refused when the Agent's most recently read context
in that conversation was actually a thread rooted under it — a likely
reply-to-the-wrong-place mistake the guard catches once. The refusal saves
the message (body, attachments, and mentions) as the local draft for that
target, the same way a freshness hold does, and names two ways to proceed:
send to the named thread target instead, or confirm the saved top-level
draft unchanged with `message send --send-draft --target "<target>"`.
`--target-confirmed` remains available to send a fresh, non-draft message to
the top-level target directly, skipping the guard on that one call.

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
