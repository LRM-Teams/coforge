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

Before `message send`, the daemon or Web/backend may hold the send
(`state: "held"`) with the newer context instead of pretending it succeeded.
The daemon saves the message as the target's local draft (kept ten minutes)
before issuing it. After consuming that context, resend the unchanged draft
with `message send --target "@user" --send-draft`, always repeating the exact
target. `--anyway` is valid only with `--send-draft` and forces the send once
Web/backend has suggested it for a draft held more than once. A successful
send consumes the draft. When a bypass succeeds, the response appends a
`--- New messages you may have missed ---` section (or, with `--json`, a
`recentUnread` array) listing the pending messages the bypass just skipped
past; every other successful send reports none.

One logical send keeps one `idempotencyKey`. The draft stores the key of the
send it came from, and `--send-draft` resends under that key, so the server can
never commit the same message twice. A key that already committed is answered
from its record as that send (`reason: "already_committed"`), before the target
or its freshness is checked, so a later change (the person left, newer
messages arrived) never reports it refused or held. Only the send whose key the draft holds
clears it. `--send-draft --expected-draft-key <key>` refuses with
`SAVED_DRAFT_IDENTITY_CHANGED`, before any request, when the draft now belongs
to another send. A draft past its ten minutes is not sent: `--send-draft`
fails with `SEND_DRAFT_EXPIRED`, removes it, and prints its body as the last
copy (`details.discarded_draft` with `--json`); the original may already have
been delivered, so read the target before resending.

When a send's outcome is ambiguous (the connection failed before any
response, or the server answered 5xx, readable body or not), the daemon does
not retry blind. It
asks once with `reconcileOnly` whether the key committed. `committed` is a
success: the CLI prints `Message commit confirmed … no message was replayed`
(`state: "committed"` with `--json`). `not_found` replays the original send
once under the same key; if that replay fails while the draft still holds the
key, the error is `Retryable: yes` and names the exact
`message send --send-draft --expected-draft-key "<key>" --target "<target>"`
command. Otherwise, or when reconciliation is unavailable, delivery stays
unknown: `Draft saved: yes`, not retryable, do not resend. Each daemon request
of a send has a 30-second deadline (Raft's pre-response deadline), and the CLI
waits for the daemon's whole settlement plus a margin
(`AGENT_SEND_LOCAL_DEADLINE_MS` in the SDK), so the verdict always arrives.

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

When the server refuses a send with a reason written for the Agent, the error
is that reason, `Code:` is the server's stable code (or `SEND_FAILED` when it
names none), `Retryable:` is the server's, the draft stays saved, and the next
action follows the code:

- `DM_PEER_NOT_IN_WORKSPACE`: the person left the Workspace; the direct message
  is read-only, so sending again is refused the same way. Read its history or
  reach someone who is still a member.
- `TARGET_NOT_ACCESSIBLE`: an unknown username and someone outside the
  Workspace get the same answer. Correct the target.
- `MESSAGE_REQUEST_IN_PROGRESS` (409, retryable): an earlier request with the
  same key is still being processed, so delivery is UNKNOWN, not refused. The
  daemon names the draft's key: wait, then run
  `message send --send-draft --expected-draft-key "<key>" --target "<target>"`,
  which reuses the key and refuses if another send replaced the draft; never
  rewrite it as a new send.
- `AGENT_DM_RESTRICTED`: a private Agent's direct message that is read-only
  for it. Reply in a conversation it may post to.
- A 400 or 403 without a code (the send's own validation, or a rejection whose
  transaction rolled back): no message was sent; fix the problem, then run the
  command again.
- Anything else (a code this CLI does not know, or another status without a
  code): delivery is UNKNOWN, as for a transport failure; do not resend on this
  evidence.

Only a 4xx whose body is exactly `{ error, code?, retryable? }` is relayed this
way; any other upstream body is withheld.

A top-level send can be refused when the Agent's most recently read context
in that conversation was actually a thread rooted under it — a likely
reply-to-the-wrong-place mistake the guard catches once. A `message read` other
than `--around`, and a send held for newer messages whose context was shown
(not withheld), count as reading a target; a thread counts only once such a
read has shown the Agent a message in it, and stays counted across Agent
restarts. A `check` consumes messages without counting as a read, so checking
the parent does not clear the guard. The refusal saves the message (body,
attachments, and mentions) as the local draft for that
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
