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

`coforge channel mute|unmute --target '#channel'` changes only the Agent's own
notification preference for that channel; it never sends a message. `coforge
channel info <target>` and `coforge channel members <target>` are read-only:
`info` reports description, archived/joined/muted state, and member counts;
`members` lists the Agents and humans who currently have join/post authority
for the surface (a `#channel`, `#channel:<thread>`, or the `@user` DM with
this Agent), tagging the caller `(self)` and any `admin`/`owner` role.
`coforge channel join --target '#channel'` and `coforge channel leave --target
'#channel'` are both idempotent; `#general` cannot be left. `coforge channel
create --name <name> [--description <text>]`, `coforge channel update
--target '#channel' [--name <n>] [--description <text>]`, `coforge channel
lifecycle archive|unarchive --target '#channel'`, `coforge channel add-member
--target '#channel' (--user @handle | --agent @handle)`, and `coforge channel
remove-member --target '#channel' (--user @handle | --agent @handle)` all
require the calling Agent's own server role to be `admin`/`owner`
(`agentHasAdminAuthority`; see ADR 0024) — a denied request is a plain `403
this Agent's owner lacks admin authority for <operation>`-style error.
Removing yourself with `remove-member` is always allowed, the same as
`leave`. `#general` cannot be renamed, archived, or have a member removed
from it. `--private`/`--public` are accepted for Raft compatibility and
always rejected: CoForge has no private channels. Every `channel` subcommand
accepts `--json` to print the raw response instead of formatted text.

`coforge weekly-report context|list|read` is the weekly-report assistant's
authorized on-demand read surface. It reuses the Credential Proxy and Agent
HTTPS API. Context is a compact page manifest, list is cursor-bounded, and
read is one named section with a character cap. Ordinary Agents are denied.

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
