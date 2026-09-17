# ADR 0022: `message send` attachments, structured mentions, target confirmation, and recent-unread

Status: accepted
Date: 2026-09-17

## Context

`coforge message send` covered `--target`, `--send-draft`, `--anyway`,
`--reviewer-isolation`, and `--json`, but not:

- attaching a file already uploaded to the target conversation;
- binding an `@handle` in the message body to a specific actor id, so a
  channel mention cannot be silently misdirected by a handle collision or a
  quoted name;
- confirming an unusual top-level send when the Agent's most recent read
  context in that conversation was actually a thread rooted under it (a
  likely reply-to-the-wrong-place mistake);
- learning, on a successful `--anyway` bypass, which pending messages the
  send just bypassed — today the Agent only sees that count via the
  preceding hold, and the sent response goes back to knowing nothing about
  them.

Raft Computer 1.0.32 is prior art for this shape of `raft message send`; per
`docs/agents/reference-cli-research.md` and repository policy, this record
uses that product's observable behaviour only as the specification for what
"aligned" means, and copies none of its code, identifiers, or wording.

Two related capabilities are deliberately out of scope, decided here rather
than left ambiguous:

- **Drive-by-join mute tip.** Raft warns a newly-joined-on-post channel member
  about notification volume. CoForge Agents cannot join a channel by posting —
  `getAgentChannel` throws `ACCESS_DENIED` for a non-member — so there is no
  join-on-post to warn about, ever.
- **`coforge attachment upload`.** Agents have no upload route today
  (`Attachment.uploaderId` is a `User` foreign key); building one is a
  separate follow-up. This record's `--attachment-id` therefore only ever
  succeeds for an attachment a human already uploaded into the same
  conversation and left unlinked to any message — see "Known limitation"
  below.

## Decision

**1. `--attachment-id <uuid>` attaches one already-uploaded, unlinked
attachment.** At most one occurrence; combined with `--send-draft` it is a
usage error (`INVALID_ARG`, `draftSaved: false`, no request issued) because a
draft resend already carries whatever attachment it was saved with — "use a
normal send to replace the draft" is the correct escape hatch, not a second
flag. The id travels CLI → daemon (`LocalAgentMessageRequest.attachmentId`,
persisted on the draft) → Web (`AgentMessagesSendRequest.attachmentId`, 400
`{ error: "invalid attachmentId" }` if not a UUID) → repository. Inside
`PrismaDirectConversationRepository.sendAgentMessage`'s transaction, the
attachment row must exist with the same `workspaceId`, the same
`conversationId` as the resolved target, and `messageId: null`; otherwise the
transaction throws `AppError("ACCESS_DENIED")`, which `handleAgentMessagesPost`
now catches and maps to 403 (previously any thrown error here surfaced as a
framework 500 — this route did not catch `AppError` at all before this
record). The hold store's `bodyHash` stays computed on the body only, so a
`--send-draft` resend of a held reply is unaffected by which attachment (if
any) rides along with it.

*Known limitation:* because Agents have no upload route, the only ids that
ever pass validation are attachments a human uploaded into the same
conversation and left unlinked. This is accepted as this record's scope, not
silently worked around; `coforge attachment upload` is the named follow-up.

**2. `--mention <actor>` (repeatable) binds a handle to a specific actor id.**
Value shape is `human:<actor-uuid>:<handle>` (`human` → type `user`) or
`agent:<actor-uuid>:<handle>`; the handle must match the server's mention
grammar (`^[a-z0-9][a-z0-9_-]*$`, ≤128 chars) — the same grammar
`apps/web/src/server/conversations/mentions.ts` already uses, duplicated (with
a comment naming that file as the source of truth) into a new
`packages/coforge/src/mentions.ts` because the CLI package cannot import from
`apps/web`. Three failures are pre-issuance `CliError`s (`draftSaved: false`,
nothing sent, `--json`-aware via the existing `withOutputMode` path): a
malformed selector (`INVALID_MENTION_SELECTOR`), the same handle bound to two
different actors in one message (`MENTION_BINDING_CONFLICT`), and a bound
handle that does not literally appear as `@handle` in the body outside fenced
or inline code (`MENTION_NOT_IN_CONTENT`, checked once the body is known, so
it does not apply when `--send-draft` reuses a saved body without an
explicit override). `--mention` values on `--send-draft` replace the draft's
saved mentions when given, and are otherwise reused from the draft — mirroring
`--attachment-id`'s draft persistence, both live on `AgentMessageDraft` as
optional fields so an older draft file without them still loads. Web
validates shape (array, max 32, `type` in `user|agent`, `id` a UUID, `name`
matching the grammar) before calling the repository, which — inside the same
transaction as the attachment check — resolves each binding against a
`conversationMember` of the target conversation (`type: "user"` → `userId`
+`user.username`; `type: "agent"` → `agentId` + `agent.name`); any miss throws
`AppError("INVALID_INPUT", { errorId: <handle> })`, mapped by the route to 400
`{ error: "mention binding does not match a conversation member: @<handle>" }`
(the id embeds only the already-grammar-validated handle, never a raw UUID).
Every validated binding's member id joins the existing name-resolved
`mentionedNames` set when creating `ThreadFollow` rows for a channel thread
reply — a union, not a replacement, so an already-correct plain `@handle`
mention keeps working exactly as before.

**3. `--target-confirmed` guards an unusual top-level send.** The attention
index (`AgentMessageAttentionIndex`) gains a volatile, per-Agent,
monotonically increasing read-context counter — `recordReadContext(agentId,
target)`, `readOrder(agentId, target)`, `latestThreadReadUnderParent(agentId,
parentTarget)` — recorded at every point the Agent already consumes messages
for a target: an explicit `read`, each `check`/events-drain page (per
target), and the held-context messages `#sendAgentMessage` returns for the
send's own target. `#sendAgentMessage` checks this, before saving any draft or
issuing any transport call, only when the request is not `--send-draft`, not
already `--target-confirmed`, and the target is top-level
(`threadParentTarget(target) === undefined` — a small helper added next to
`isChannelMessageTarget` in `packages/coforge-sdk/src/internal/index.ts` and
shared by the CLI and the daemon). If the most recently read thread rooted
under that parent has a higher read order than the parent's own last read (or
the parent was never read at all), the send is refused with
`AgentPreflightError` (`THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED`): no
draft saved, no request issued (`draftSaved: false` via the CLI's existing
`local_precondition` mapping, the same path `NO_HELD_DRAFT` already uses). The
message names the mismatch, explains that the guard is deliberately narrow
(moving a thread's conclusion to the parent channel can be correct), and gives
both escape hatches — send to the thread target instead, or re-run with
`--target-confirmed`. `AgentPreflightError` cannot currently carry a
`suggestedNextAction` through `agent-proxy-failure.ts` to the CLI (that field
is defined on the wire contract but no branch of
`classifyAgentProxyFailure` populates it yet), so the equivalent one-sentence
next action is folded into the message text itself rather than widening that
shared path for one caller. `targetConfirmed` never leaves the daemon — it is
not part of `AgentMessageRequest`, the daemon-to-Web wire type.

**4. A successful `--anyway` bypass returns what it bypassed.**
`executeAgentSendMessageWithPolicy`, on the `sideEffectDecision:
"anyway_accepted"` path in `"inline"` mode, returns the last-three pending
messages it would otherwise have held (`pending?.slice(-3) ?? []`) as
`recentUnread`; every other sent result — forward, or any withheld-mode
result — reports `recentUnread: []`, never bodies in withheld mode.
`AgentSendResponse.recentUnread?: AgentMessage[]` is populated by
`mapSendResult` only for `state: "sent"`. The daemon adapts it into
`AgentMessageTransportResponse.recentUnread`, records `modelSeen` for the
target from it exactly like it already does for the primary `messages` field
(so the *next* send's `seenUpToSequence` advances past what the Agent was
just shown), and returns it on the local `AgentMessageResponse`. The CLI
appends a `--- New messages you may have missed ---` section (one
`formatMessageLine` per message) after the existing `Message sent...` line in
text mode, and adds the raw `recentUnread` array to the `--json` object
(present, possibly empty, on every sent response — this is an additive,
backward-compatible field on an object that was previously missing it
entirely).

## Rejected alternatives

- **Building `coforge attachment upload` in the same change.** Rejected as
  out of scope: it needs its own upload-route design (multipart handling,
  size limits, an Agent-facing `Attachment.uploaderId` story) independent of
  send's contract. Recorded as a named follow-up instead of silently
  skipped.
- **Warning about drive-by channel joins.** Rejected: it does not apply to
  this product's membership model; adding dead code for a Raft-only scenario
  would misdescribe CoForge's actual authorization boundary.
- **Giving `AgentPreflightError` a general `suggestedNextAction` field now.**
  Rejected for this change: it would widen `agent-proxy-failure.ts` and
  `local-client.ts`'s shared preflight-error path for every existing caller
  (`NO_HELD_DRAFT`, `AGENT_MESSAGE_BODY_REQUIRED`, …) to serve one new guard.
  Folding the guidance into this guard's own message text is narrower and
  reversible; widening the shared path is a separate decision if a second
  caller needs it.
- **Replacing name-resolved thread-follow mentions with structured ones.**
  Rejected: `mentionedNames`-based resolution is the existing, working
  contract for plain-text `@handle` mentions; structured mentions are an
  additional, stronger guarantee (an explicit id/name binding a server can
  verify), not a replacement. Union, not override.

## Consequences

- `packages/coforge-sdk`: `local_rpc.proto` gains `attachment_id`,
  `mentions` (new `MentionSelector` message), and `target_confirmed` on
  `LocalAgentMessageRequest`, and `recent_unread` on `AgentMessageResponse`;
  regenerated code plus hand-written `local-daemon.ts` encode/decode updates.
  `AgentMessageRequest` (the daemon-to-Web wire type) gains `attachmentId`/
  `mentions` (never `targetConfirmed`). `agent/messages.ts` gains
  `AgentMessagesSendRequest.attachmentId`/`mentions` and
  `AgentSendResponse.recentUnread`. `internal/index.ts` gains
  `threadParentTarget`.
- `packages/daemon`: `AgentMessageDraftStore`/`AgentInboxStateMachine` persist
  `attachmentId`/`mentions` on a draft (backward compatible — an older draft
  file without them still loads); `AgentMessageAttentionIndex` gains
  `recordReadContext`/`readOrder`/`latestThreadReadUnderParent`;
  `#sendAgentMessage` gains the target-confirmed guard, forwards the new
  fields, and adapts `recentUnread`; `agent-proxy.ts` validates the new
  payload fields; `daemon-connection.ts` forwards `attachmentId`/`mentions`
  in the send HTTP body and adapts `recentUnread` back.
- `apps/web`: the send route validates and forwards the new fields, catches
  `AppError` and maps `ACCESS_DENIED`/`INVALID_INPUT` to 4xx (previously
  unhandled → 500); `agent-messages.service.ts` computes `recentUnread`;
  `direct-message.server.ts` forwards `attachmentId`/`mentions` (previously
  hardcoded `undefined` for the attachment); the repository validates both
  inside the existing send transaction and unions mention-bound member ids
  into the thread-follow set.
- `packages/coforge`: new `src/mentions.ts` (parsing and the content-presence
  check); `index.ts` parses and validates the three flags and renders
  `recentUnread`; `local-client.ts` and `message-format.ts` carry the new
  fields through.
- No schema or migration change: attachment and mention-binding validation
  read existing tables (`Attachment`, `ConversationMember`) without adding
  any.

## Validation and rollback

Validation is `bun run check`, `bun run test`, and `bun run build` from the
repository root, covering: `packages/coforge-sdk`'s codec round-trip tests;
`packages/coforge`'s CLI parsing/rendering tests including the new
`mentions.ts` unit tests; `packages/daemon`'s attention-index, draft-store,
and daemon-runtime tests (the target-confirmed guard, attachment/mention
forwarding and draft persistence, and `recentUnread` advancing `modelSeen`);
and `apps/web`'s send-route, service, and direct-message tests (attachment/
mention shape validation, the `AppError`-to-4xx mapping, and a full
hold→hold→bypass flow asserting `recentUnread`). The Web integration suites
that need a live Postgres/Redis (`*.integration.ts`) are unaffected by this
change's default `bun test` selection and continue to require their
documented `*_TEST_DATABASE_URL` environment variables to run.

Rollback is reverting this change's CRs before merge (no schema migration is
part of this change, so there is nothing to migrate back); post-merge,
reverting is a normal follow-up CR. Because every new field is additive and
optional on every wire type, an old CLI/daemon build talking to a new server
(or vice versa) degrades to today's behaviour rather than failing to decode.
