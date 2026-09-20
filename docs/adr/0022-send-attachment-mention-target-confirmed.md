# ADR 0022: `message send` attachments, structured mentions, target confirmation, and recent-unread

Status: accepted (partially superseded)
Date: 2026-09-17

Status: partially superseded by [ADR 0057](0057-message-freshness-hold-contract.md) for the freshness hold: the held/send response shape, the `holdToken`/`anywayAllowed` fields and the `denied` state described below were replaced by Raft's contract.

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
attachment.** At most one occurrence; a non-UUID value is a typed usage error
(`INVALID_ARG`, `draftSaved: false`, the same `withOutputMode` pre-issuance
path other flag errors use); combined with `--send-draft` it is the same
typed error family because a draft resend already carries whatever attachment
it was saved with — "use a normal send to replace the draft" is the correct
escape hatch, not a second flag. The id travels CLI → daemon
(`LocalAgentMessageRequest.attachmentId`, persisted on the draft) → Web
(`AgentMessagesSendRequest.attachmentId`, 400 `{ error: "invalid attachmentId"
}` if not a UUID) → repository. Inside
`PrismaDirectConversationRepository.sendAgentMessage`'s transaction, the
attachment row must exist with the same `workspaceId`, the same
`conversationId` as the resolved target, and `messageId: null`; otherwise the
transaction throws a new, send-specific `AgentSendRejectedError(403, "attachment
is not available for this message")` (next to
`agent-message-validation-error.server.ts`), which `handleAgentMessagesPost`
catches and maps to 403 (previously any thrown error here surfaced as a
framework 500 — this route did not catch anything at all before this record).
The hold store's `bodyHash` stays computed on the body only, so a
`--send-draft` resend of a held reply is unaffected by which attachment (if
any) rides along with it.

*Why a dedicated error class, not `AppError`:* the first version of this
change threw `AppError("ACCESS_DENIED")`/`AppError("INVALID_INPUT")` for these
two conditions and mapped those codes in the route. Review caught that this
was wrong: `getAgentChannel` (called earlier in the same request, resolving a
channel target) already throws exactly those two `AppError` codes for a
non-member Agent or a malformed channel name, and the route's blanket mapping
mis-reported both as an attachment/mention failure. `AgentSendRejectedError`
is a distinct class the route matches with `instanceof`, so it is only ever
thrown for the two conditions this record introduces; every other error
(`AppError` included) propagates exactly as it did before this class existed.

*Known limitation:* because Agents have no upload route, the only ids that
ever pass validation are attachments a human uploaded into the same
conversation and left unlinked. This is accepted as this record's scope, not
silently worked around; `coforge attachment upload` is the named follow-up.

**2. `--mention <actor>` (repeatable) binds a handle to a specific actor id.**
Value shape is `human:<actor-uuid>:<handle>` (`human` → type `user`) or
`agent:<actor-uuid>:<handle>`; the handle must match the server's mention
grammar (`^[a-z0-9][a-z0-9_-]*$`, ≤128 chars). The grammar, the selector
parser, the content-presence check, and the wire-shape array validator live in
exactly one place — `packages/coforge-sdk/src/internal/mentions.ts`, exported
from `internal/index.ts` — imported by the CLI (`packages/coforge/index.ts`;
the package no longer has its own `src/mentions.ts`), the daemon
(`agent-proxy.ts`'s payload validation and `runtime.ts`'s presence check), and
Web (the send route's shape validation; `apps/web/src/server/conversations/
mentions.ts`'s plain-text `mentionedNames` scan now imports the same
`MENTION_PATTERN` instead of keeping its own copy). This CLI package cannot
import from `apps/web`, which is why the definition lives in the SDK rather
than in either endpoint.

Three failures are pre-issuance `CliError`s (`draftSaved: false`, nothing
sent, `--json`-aware via the existing `withOutputMode` path): a malformed
selector (`INVALID_MENTION_SELECTOR`), the same handle bound to two different
actors in one message (`MENTION_BINDING_CONFLICT`), and — client-side, only
when the body is already known, i.e. never for an unmodified `--send-draft`
resend — a bound handle that does not literally appear as `@handle` in the
body outside fenced or inline code (`MENTION_NOT_IN_CONTENT`). The daemon runs
the same presence check again, unconditionally, inside `#sendAgentMessage`,
against the *effective* mentions (an explicit `--mention` override, or the
draft's saved mentions) and the *effective* body (fresh or the draft's saved
body) — Raft checks `structuredRaftMentionStillAppears` against the outgoing
content on every path, including a saved draft, and the daemon is the one
place that always holds both a `--send-draft` resend's real body and its
mentions. This authoritative daemon-side check throws the same
`AgentPreflightError`/`MENTION_NOT_IN_CONTENT` before anything is (re)saved,
so a resend with a bad override never reaches the transport. `--mention`
values on `--send-draft` replace the draft's saved mentions when given, and
are otherwise reused from the draft — mirroring `--attachment-id`'s draft
persistence, both live on `AgentMessageDraft` as optional fields so an older
draft file without them still loads.

Web validates shape (array, max 32, `type` in `user|agent`, `id` a UUID,
`name` matching the grammar, via the same SDK validator) before calling the
repository, which — inside the same transaction as the attachment check —
resolves each binding against a `conversationMember` of the target
conversation (`type: "user"` → `userId` + `user.username`; `type: "agent"` →
`agentId` + `agent.name`); any miss throws
`AgentSendRejectedError(400, "mention binding does not match a conversation
member: @<handle>")` (see point 1 for why this is its own class, not
`AppError`). Every validated binding's member id joins the existing
name-resolved `mentionedNames` set when creating `ThreadFollow` rows for a
channel thread reply — a union, not a replacement, so an already-correct
plain `@handle` mention keeps working exactly as before.

**3. `--target-confirmed` guards an unusual top-level send.** The attention
index (`AgentMessageAttentionIndex`) gains a volatile, per-Agent,
monotonically increasing read-context counter — `recordReadContext(agentId,
target)`, `readOrder(agentId, target)`, `latestThreadReadUnderParent(agentId,
parentTarget)` — recorded at every point the Agent already consumes messages
for a target: an explicit `read`, each `check`/events-drain page (per
target), and the held-context messages `#sendAgentMessage` returns for the
send's own target. `#sendAgentMessage` checks this, before issuing any
transport call, only when the request is not `--send-draft`, not already
`--target-confirmed`, and the target is top-level
(`threadParentTarget(target) === undefined` — a small helper added next to
`isChannelMessageTarget` in `packages/coforge-sdk/src/internal/index.ts` and
shared by the CLI and the daemon). `--send-draft` itself always skips this
guard, matching Raft's `if (!opts.sendDraft && !opts.targetConfirmed)`.

If the most recently read thread rooted under that parent has a higher read
order than the parent's own last read (or the parent was never read at all),
**the guard saves the outgoing content — body, `attachmentId`, and
`mentions` — as the local draft for `target` (no hold token) before
refusing**, matching Raft exactly: the recovery is resending that saved
draft unchanged, not retyping the message. It then throws
`AgentPreflightError` (`THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED`,
`draftSaved: true`). The message names the mismatch, explains that the guard
is deliberately narrow (moving a thread's conclusion to the parent channel
can be correct), and gives both escape hatches — send to the thread target
instead, or confirm the saved top-level draft with `coforge message send
--send-draft --target "<target>"` (the CLI's own `--attachment-id` +
`--send-draft` restriction is unaffected: `--send-draft` never needs a new
attachment, since the guard already saved whichever one was on the original
attempt). `--target-confirmed` remains the other, direct bypass for a fresh
(non-draft) send.

`AgentPreflightError` gained an optional `draftSaved` field (default
`undefined`, rendered as `false`) so this one caller can report `true`
without changing any other preflight error's behaviour (every other one —
`NO_HELD_DRAFT`, `AGENT_MESSAGE_BODY_REQUIRED`, `HELD_DRAFT_TOKEN_UNAVAILABLE`,
… — still reports `false`, since none of them persist a draft).
`agent-proxy-failure.ts` carries it into the proxy error JSON as a new
`proxy.draft_saved` field (only ever present for `failure_class:
"local_precondition"`), and `local-client.ts#proxyHttpFailure` honours it when
present, falling back to its existing `!isLocalPrecondition` default
otherwise — so every other local-precondition error is unaffected.
`AgentPreflightError` still cannot carry a `suggestedNextAction` through this
path (see "Rejected alternatives"), so the equivalent guidance stays folded
into the message text. `targetConfirmed` never leaves the daemon — it is not
part of `AgentMessageRequest`, the daemon-to-Web wire type.

**A `--send-draft` resend of a tokenless draft — one saved by this guard, or
by a transport failure before ever reaching a hold — sends as a plain send.**
`#sendAgentMessage` no longer refuses a tokenless draft outright: it omits
`holdToken` from the transport request (there is none) and only refuses with
`HELD_DRAFT_TOKEN_UNAVAILABLE` when the caller also passed `--anyway`, since
there is no hold for `--anyway` to bypass. `inbox.clear`/`inbox.replace`
after the transport call are unchanged, so a successful plain resend still
clears the draft exactly like an ordinary accepted send.

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
- **Reusing generic `AppError` codes for the attachment/mention send
  rejections.** Tried first, then rejected on review: `getAgentChannel`
  already throws `AppError("ACCESS_DENIED")`/`AppError("INVALID_INPUT")` for
  an ordinary non-member/malformed-channel failure earlier in the same
  request, and a route-level mapping keyed only on those codes cannot tell
  the two situations apart — it mis-reported a channel-access denial as an
  attachment failure. `AgentSendRejectedError` is a dedicated class the route
  matches with `instanceof`, so only the two conditions this record
  introduces are ever mapped; everything else propagates unchanged.
- **Re-run with `--target-confirmed` as the guard's only recovery
  (this record's original decision).** Superseded on review to match Raft
  exactly: Raft saves the outgoing content as the local draft before
  refusing and documents `--send-draft` as the primary recovery, with
  `--target-confirmed` as the other option, not the only one. The original
  "re-run the same send with `--target-confirmed`" text required retyping
  the message from scratch, which Raft does not require and which is worse
  UX than resending a preserved draft.

## Consequences

- `packages/coforge-sdk`: `local_rpc.proto` gains `attachment_id`,
  `mentions` (new `MentionSelector` message), and `target_confirmed` on
  `LocalAgentMessageRequest`, and `recent_unread` on `AgentMessageResponse`;
  regenerated code plus hand-written `local-daemon.ts` encode/decode updates.
  `AgentMessageRequest` (the daemon-to-Web wire type) gains `attachmentId`/
  `mentions` (never `targetConfirmed`). `agent/messages.ts` gains
  `AgentMessagesSendRequest.attachmentId`/`mentions` and
  `AgentSendResponse.recentUnread`. `internal/index.ts` gains
  `threadParentTarget`, plus a new `mentions.ts` module (`parseMentionSelector`,
  `stripCodeSpans`/`mentionsInContent`, `MENTION_PATTERN`,
  `isValidMentionSelectorArray`) that is the one definition of the mention
  grammar for every layer.
- `packages/daemon`: `AgentMessageDraftStore`/`AgentInboxStateMachine` persist
  `attachmentId`/`mentions` on a draft (backward compatible — an older draft
  file without them still loads); `AgentMessageAttentionIndex` gains
  `recordReadContext`/`readOrder`/`latestThreadReadUnderParent`;
  `#sendAgentMessage` gains the target-confirmed guard (now saving a draft
  before refusing) and the unconditional mention-presence check, forwards the
  new fields, sends a tokenless `--send-draft` resend as a plain send, and
  adapts `recentUnread`; `agent-proxy.ts` validates the new payload fields
  using the SDK's shared mention validator; `daemon-connection.ts` forwards
  `attachmentId`/`mentions` in the send HTTP body and adapts `recentUnread`
  back; `AgentPreflightError` gains `draftSaved`; `agent-proxy-failure.ts`
  carries it as `proxy.draft_saved`.
- `apps/web`: the send route validates and forwards the new fields, catches
  the new `AgentSendRejectedError` and maps its `status`/`message` directly
  (previously unhandled on this route → 500); `agent-messages.service.ts`
  computes `recentUnread`; `direct-message.server.ts` forwards
  `attachmentId`/`mentions` (previously hardcoded `undefined` for the
  attachment); the repository validates both inside the existing send
  transaction (throwing the new error class, not `AppError`) and unions
  mention-bound member ids into the thread-follow set;
  `server/conversations/mentions.ts` now imports `MENTION_PATTERN` from the
  SDK instead of keeping its own copy of the regex.
- `packages/coforge`: `index.ts` imports mention parsing/validation from
  `@lrm/coforge-sdk/internal` (no local `src/mentions.ts` any more), parses
  and validates the three flags — including a typed `CliError` for a
  non-UUID `--attachment-id` — and renders `recentUnread`; `local-client.ts`
  and `message-format.ts` carry the new fields through, and `local-client.ts`
  honours a proxy-reported `draft_saved` on a local-precondition failure.
- No schema or migration change: attachment and mention-binding validation
  read existing tables (`Attachment`, `ConversationMember`) without adding
  any.

## Validation and rollback

Validation is `bun run check`, `bun run test`, and `bun run build` from the
repository root, covering: `packages/coforge-sdk`'s codec round-trip tests
and the new `mentions.ts` unit tests (the grammar's single definition);
`packages/coforge`'s CLI parsing/rendering tests, including the typed
`--attachment-id`/`--mention` usage errors; `packages/daemon`'s
attention-index, draft-store, agent-proxy-failure, and daemon-runtime tests
(the target-confirmed guard saving a draft and reporting `draftSaved: true`,
a tokenless-draft `--send-draft` resend sending as a plain send and rejecting
`--anyway`, the mention-presence check firing on a `--send-draft` override,
attachment/mention forwarding and draft persistence, and `recentUnread`
advancing `modelSeen`); and `apps/web`'s send-route, service, and
direct-message tests (attachment/mention shape validation,
`AgentSendRejectedError`'s mapping — and the regression test confirming a
plain `AppError("ACCESS_DENIED")` from channel resolution is never
mis-reported as an attachment error — and a full hold→hold→bypass flow
asserting `recentUnread`). `packages/coforge`'s `local-client.test.ts` covers
`draft_saved` propagation into `CliError.draftSaved`. The Web integration
suites that need a live Postgres/Redis (`*.integration.ts`) are unaffected by
this change's default `bun test` selection and continue to require their
documented `*_TEST_DATABASE_URL` environment variables to run.

Rollback is reverting this change's CRs before merge (no schema migration is
part of this change, so there is nothing to migrate back); post-merge,
reverting is a normal follow-up CR. Because every new field is additive and
optional on every wire type, an old CLI/daemon build talking to a new server
(or vice versa) degrades to today's behaviour rather than failing to decode.
