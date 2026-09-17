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
When a bypass succeeds, the response appends a `--- New messages you may have
missed ---` section (or, with `--json`, a `recentUnread` array) listing the
pending messages the bypass just skipped past; every other successful send
reports none.

`message send` accepts `--attachment-id <uuid>` to attach one attachment
already uploaded to the target conversation and left unlinked to any
message — Agents have no upload route today, so this only ever succeeds for
an attachment a human uploaded first. It must be a full UUID and cannot be
combined with `--send-draft`; send a normal message to replace the draft
instead. `--mention human:<actor-uuid>:<handle>` or `--mention
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
the message (body, attachment, and mentions) as the local draft for that
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

`coforge attachment upload --path <file> --target <target> [--mime-type <type>]`
uploads a local file and prints its attachment id for
`coforge message send --attachment-id <id>`. `--target` uses the same
`#channel`/`@user` grammar as `message send`; the Agent must already belong to
that conversation. `--channel <target>` is accepted as a legacy alias for
`--target` (Raft's transition alias); passing both is a usage error even when
they agree. Local checks run in this order, matching Raft 1.0.32: `--path`
presence, existence, regular-file, non-empty (all `INVALID_ARG`), then
`--target`/`--channel` presence (`MISSING_CHANNEL`), then `--mime-type`
well-formedness (`INVALID_ARG`) — the first failing check wins. Without
`--mime-type`, the type is inferred from the file extension (falling back to
`application/octet-stream`). Before uploading, the CLI checks the file
against the server's advertised size limit; a capabilities lookup that 404s
is treated as "no limit advertised" and skips this client-side check (the
server still enforces its own limit), any other capabilities failure is
`UPLOAD_CAPABILITY_FAILED`, and a file over an advertised limit is rejected
locally with `ATTACHMENT_TOO_LARGE`, never partially uploaded. On success it
prints:

```
File uploaded: <fileName> (<sizeKB>KB)
Attachment ID: <id>

Use this ID with coforge message send --attachment-id <id> to include it in a message.
```

`--json` prints the raw response object instead. Download an attachment's
bytes with `coforge attachment view <id> --output <path>` (or `--id <id>`,
not both — `INVALID_ARG` either way if the id or `--output` is missing).
On success it prints `Downloaded to: <path>` (matching Raft 1.0.32's
`formatAttachmentDownloaded`); `--json` prints `{ attachmentId, path }`
instead. A download failure is `VIEW_FAILED` (`SERVER_5XX` for ≥ 500), with
a fixed `Attachment is unavailable.` message on a 404 rather than relaying
upstream detail. An Agent may download its own upload before sending it,
but not another Agent's not-yet-sent upload.

`coforge weekly-report context|list|read` is the weekly-report assistant's
authorized on-demand read surface. It reuses the Credential Proxy and Agent
HTTPS API. Context is a compact page manifest, list is cursor-bounded, and
read is one named section with a character cap. Ordinary Agents are denied.

## Action cards

`coforge action prepare --target <target>` posts a typed "action card" — a
proposed change a human later commits under their own identity — into
`<target>` (the same `#channel[:thread]` / `@user[:thread]` grammar as
`message send`; the Agent must already be a member). The card's JSON body is
read from stdin, either a real shell heredoc or a literal body whose first
and last lines are the delimiter `COFORGEACTION` (Raft Computer 1.0.32 uses
`RAFTACTION` for the same purpose), or raw JSON with no delimiter:

```
coforge action prepare --target "#design" <<'COFORGEACTION'
{"type":"channel:create","name":"design","visibility":"public"}
COFORGEACTION
```

Three kinds are supported today; CoForge does not yet implement Raft's
`integration:*` kinds:

- **`channel:create`**: `name` (1-32 chars, `^[a-z0-9][a-z0-9_-]{0,31}$` after
  trimming a leading `#`), `visibility` (`public` or `private`; `private`
  is accepted by validation but rejected by the server — not supported
  yet), `description?` (≤500 chars), `initialHumans?`/`initialAgents?`
  (≤64 handles or UUIDs each), `draftHint?` (≤2000 chars).
- **`agent:create`**: `name` (`^[a-z0-9]+(?:-[a-z0-9]+)*$`, ≤64 chars),
  `description?`, `suggestedComputer?`, `requiredComputer?` (handle or
  UUID; at most one of the two), `draftHint?`. No `runtime`, `model`, or
  `reasoning` field — those stay human-picked.
- **`channel:add_member`**: `channel` (handle or UUID), `humans?`,
  `agents?` (at least one of the two non-empty), `draftHint?`.

Identity fields (`initialHumans`, `initialAgents`, `suggestedComputer`,
`requiredComputer`, `channel`, `humans`, `agents`) are handles the Agent
already knows — `@alice`, `alice`, `#general`, `general` — or a UUID; the
server resolves each one at prepare time and fails the whole request with
the offending field named if any handle does not resolve. The Agent never
invents a database id.

Local zod validation, then `validateActionCardAction`'s cross-field rules
(`agent:create` may set at most one of `suggestedComputer`/
`requiredComputer`; `channel:add_member` needs at least one human or
agent), run before the request is sent; a failure is reported as
`Action failed validation: <path>: <message>; …`. A non-2xx server response
is reported with the server's error text. On success the CLI prints:

```
Action card posted to <target> as message <uuid> (short <first 8>). The human can click the action verb to commit.
```

This PR only posts and persists the card as an ordinary Agent message; the
card UI and the human's commit action are a follow-up (see ADR 0027).

## Output

The CLI renders five plain-text formats:

- **Message line** (`message check`, `message resolve`, held-send context):
  `[target=<target> msg=<shortId> time=<utc>] <sender>: <body>`, plus an
  attachment suffix and/or a task suffix when present.
- **Read window** (`message read`): a header reporting how many messages
  were returned and whether older/newer messages exist, with the exact
  `--before`/`--after` cursor command to paste; numbered lines each carry a
  `replyTarget` to reuse when replying in a thread; the window closes with
  an "End of window" line.
- **Search result block** (`message search`): each hit is a
  `<result ref="msg:<uuid>">` block with `Source`, `Sender`, `Time`, and a
  `<preview>` that wraps the matched text in `<match>...</match>` and
  rewrites quoted `@name`/`#chan`/`task #n` references to
  `user:name`/`channel:name`/`task:n` so they are never mistaken for real
  targets; a footer points to
  `coforge message read --target <target> --around <message-id>` for more
  context.
- **Send success**: `Message sent to <target>. Message ID: <full uuid>`,
  plus a reply-target hint when `<target>` is not already a thread target.
- **Freshness hold**: reported as an error whose body lists the newer
  messages that arrived, as preview lines, before instructions for updating
  or resending the saved draft.

Sequence numbers and hold tokens are never printed; Agents only ever see
opaque message ids.
