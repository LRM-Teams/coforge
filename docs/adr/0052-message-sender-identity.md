# ADR 0052: A message's sender is a kind, a handle and a description — not one string

Status: accepted
Date: 2026-09-20

## Context

Every Agent-facing message carries exactly one field for "who sent this": a string that is either
`"@" + handle` or the literal `"system"`. It appears on four wire messages
(`AgentMessageRecord.sender`, `AgentMessageDelivery.latest_sender`,
`AgentRecoveryMessage.latest_sender`, `MessageAttentionSummary.latest_sender`), and the model sees
it verbatim as the text after `]` on a message line.

Fusing the identity and its kind into one string has cost us three things.

**The kind is unrecoverable.** A human and an Agent both render as `@name`. Only `system` is
distinguishable, and only because the word is hard-coded. `agent-instructions.ts` currently
instructs the model to infer the sender kind from the string's shape, which is a guess dressed as a
contract.

**A missing name becomes a malformed identity instead of a caught error.** Six call sites compose
the string independently, with six different rules:

| Site | Rule | Failure |
| --- | --- | --- |
| `direct-conversation.repositories.server.ts:1222` | `` `@${sender.user?.username}` `` | `@undefined` when the sender is an Agent |
| `:1299` | `agentSenderHandle(...)` | — |
| `:1500` | `row.senderMemberId === null ? "system" : "@" + (row.senderUsername ?? "agent")` | silently attributes an unnamed sender to `@agent` |
| `:1929` | `` `@${sender.agent?.name ?? agentId}` `` | leaks an internal Agent UUID to an Agent |
| `public-channels.server.ts:1246` | `` `@${message.sender!.user!.username}` `` | two non-null assertions; an Agent-authored channel delivery has no `sender.user` |
| `task-board.server.ts:599` | passed in by the caller | — |

PR #455 was one of these: a projection selected only the human username, the sender was an Agent,
the composed string was a bare `"@"`, downstream handle validation rejected it, and a Workspace
daemon answered 503 for 12h52m without anything naming the cause. That PR fixed the projection it
found. The shape that made a name-lookup miss turn into a malformed identity is still here, and
`public-channels.server.ts:1246` is the same latent bug in the channel path.

**A sender has no room for what it is.** `Agent.description` and `User.description` both exist and
are shown in the browser's mention list (PR #350), but an Agent reading a message sees only a
handle, with no way to tell an on-call deploy bot from a teammate.

Raft 1.0.32 separates these facts and shows the kind to the model. Its
`packages/shared/src/canonicalMessageManifest.ts` classes `senderId` and `senderType` as
`canonicalRequired` — fail-closed, non-null, the same tier as `id`, `channelId`, `content` and
`createdAt` — while `senderName` and `senderDescription` sit one tier down as optional aggregates.
Its `daemonApiInboxTargetRowSchema` keeps `latestSenderName` and `latestSenderType` as two fields,
the kind a closed enum. Its Agent-visible line is
`[target=#general msg=00000000 time=… type=human] @richard: hello everyone`, and its Agent prompt
documents `type=` and tells the model that a `system` message is informational.

Raft's own alignment is partial and we are not copying it wholesale: its Agent-facing envelope
schema accepts both `senderType` and `sender_type` as untyped optional strings, its inbox
projection normalizes locally, and its kind vocabulary differs between surfaces (`human/agent/
system/third_party_app`, `user/agent`, and a bare string). What is worth taking is the manifest
layer's rule, not its implementation: **identity and kind are required facts, a display name is
not an identity, and the kind is a closed vocabulary decided once.**

## Decision

**A. The sender travels as three fields.** `sender` and `latest_sender` are replaced on all four
wire messages by:

- `sender_kind` — `string`, closed vocabulary `human | agent | system`. Follows the activity-kind
  convention of ADR 0021: a proto `string`, a TS union plus a `Set` guard in
  `packages/coforge-sdk/src/internal`, validated in `codec.ts` at the boundary. The repository's
  protobuf schemas define no enums, and this does not start.
- `sender_handle` — `string`, the public handle **without** a leading `@`. Required for
  `human` and `agent`; empty for `system`.
- `sender_description` — `string`, the sender's role text; empty when there is none.

The handle grammar is not a new rule: `sender_handle` reuses `MENTION_HANDLE_PATTERN`
(`packages/coforge-sdk/src/internal/mentions.ts`), the one character class a mention handle and a
sender handle now share, bounded to 60 code points (`SENDER_HANDLE_MAX_LENGTH`,
`message-sender.ts`) and refusing anything shaped like an actor id. Hex and hyphens are ordinary
handle characters, so a raw id satisfies the character class on its own; the rule that keeps one
from reaching an Agent as a handle has to name the id shape rather than let a length bound exclude
it by accident. That bound was chosen to match `AGENT_NAME_MAX_LENGTH`, which moved from 64
to 60 in the same change (`apps/web/src/features/agents/agent.schemas.ts`) so the identity schema
that produces an Agent's name and the wire bound that carries it as a sender handle agree on the
same ceiling instead of silently drifting apart. `assertValidMessageSender(kind, handle, context)`
is the single validation entry point every wire boundary calls — it throws `` `invalid ${context}
sender` `` — so a boundary that used to hand-roll `if (!isValidMessageSender(...)) throw new
Error(...)` now shares one implementation instead of one rule copy-pasted per site. There is no
description sanitizing: `sender_description` crosses as the stored text, unchanged.

No internal id crosses to an Agent. Raft ships `senderId`; CoForge does not, because
`workspace.proto` already records that invariant on `target` ("never expose internal agent/user ids
to Agents"), and an id would not have prevented any failure in the table above. The handle is the
public identity. This divergence is deliberate.

**B. Fail-closed, at the point the fact is built.** One exported projection —
`agentMessageSender(sender)` in `apps/web/src/server/conversations/sender-display.server.ts`,
beside the existing `browserSenderName` / `browserSenderHandle` — is the only place that reads a
sender relation and produces `{ kind, handle, description }`. It returns `kind: "system"` for a
null sender. For a non-null sender it throws a named error unless the stored name is a handle an
Agent can actually reply to; it never substitutes `"agent"`, an internal id, or an empty string,
and resolving a name is not enough — the grammar is checked here so no caller has to repeat it.
A delivery that cannot name its sender fails with a reason instead of shipping a degraded one.
All six sites above call it.

The daemon validates on receipt: a `human` or `agent` record with an empty `sender_handle`, or an
unknown `sender_kind`, is rejected with a named log line and never rendered.

**C. The model is told the kind.** The Agent-visible message line gains `type=` in its bracket
header, beside `target=`, `msg=` and `time=`:

```
[target=@alice msg=10000001 time=2026-03-15 09:00:00Z type=human] @alice: Can you look at the login bug?
[target=#general msg=10000004 time=2026-03-15 09:02:00Z type=agent] @scout — release bot: deploy finished, all green
[target=#general msg=10000005 time=2026-03-15 09:03:00Z type=system] system: @scout was assigned task #12.
```

A sender with a description renders as `@handle — description`; without one, `@handle` alone. The
Messaging section of the Agent instructions documents `type=`, lists the three values, and states
that a `system` message reports a state change and needs a reply only when it plainly asks for
action.

**D. The attention notice carries both.** `MessageAttentionSummary` keeps a per-target latest
sender as `latest_sender_kind` + `latest_sender_handle`, and the notice line renders the handle as
before. The daemon's `printableSender` regex guard is replaced by validation of the two structured
fields — a newline can no longer reach a model-visible notice through a sender name, because the
handle is matched against the handle grammar and the kind against the closed set.

## Rejected alternatives

**Keep the composed string and add the kind beside it.** Two sources for one fact, free to
disagree, and the composed string stays the thing six sites hand-build. Rejected.

**Carry a compatibility shim so an older Computer keeps working.** Development does not add
fallback code for old Computers; the server and daemon ship together and an old Computer fails
validation loudly.

**Adopt Raft's four-value vocabulary.** `third_party_app` describes a concept CoForge does not
have. A term is added when the product has the thing.

## Consequences and migration

- Breaking wire change on `local_rpc.proto` and `workspace.proto`; the SDK, daemon and Web ship in
  one CR and a Computer release follows.
- `agentSenderHandle` in `direct-conversation.repositories.server.ts` is deleted; its callers use
  the shared projection.
- The Agent-visible line changes for every message, so `agent-instructions.test.ts`,
  `message-format.ts` and their fixtures change together; the test that renders a fixture through
  `formatMessageLine` keeps the prompt examples from drifting.
- An unnamed sender now surfaces as a named server error rather than a bare `"@"` reaching a
  daemon.

## Validation and rollback

- A regression test per failure in the context table, written before the fix: an Agent-authored DM,
  an Agent-authored public channel delivery, a system-authored message, and a sender whose handle
  cannot be resolved.
- `mise run test`, `mise run check`, `mise run build`, plus `buf lint` and
  `buf format --diff --exit-code` on the changed schemas.
- Rollback is the release: reverting the CR restores the single-string field on both sides at once.
