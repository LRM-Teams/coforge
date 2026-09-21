# ADR 0057: The freshness hold is Raft's send contract, not a server-issued token

Status: proposed (2026-09-20; task #58, "hold 的没对齐的全部对齐"). The agent-facing send contract and
the daemon's local draft state change shape, which is why a review is required before merge.
Date: 2026-09-20

## Context

CoForge held a reply that arrived while newer context was pending by issuing an opaque **server-side
hold token** (Redis, 15-minute TTL, `stage` 1→2) and authorizing `--anyway` only against a valid token
at stage 2. Raft 1.0.32 decides the same situation with a **contract**, not a token:

- The client sends the state it owns: `content`, `seenUpToSeq`, `draftReholdCount`,
  `draftReplacedExisting`, `sendDraft`, `continueAnyway`
  (`agentApiSendV2BodySchema`, bundle **L16728**).
- The server answers a discriminated union of `state: "sent" | "held"` with no "denied" member
  (`agentApiSendResponseSchema`, **L16875**), and a held answer carries `decision`
  (`local_hold | syncing_hold`), `reason`, `producerFactId`, `available_actions`,
  `continueAnywaySuggested`, `heldMessages`, `newMessageCount`, `shownMessageCount`,
  `omittedMessageCount`, `seenUpToSeq`, `mentionAnnotation`
  (`agentApiHeldFreshnessResponseSchema`, **L16859**).
- The decision itself is the planner's (`planAgentInboxSideEffect`, **L815610**): `continueAnyway` →
  `bypass` (never refused); unconsumed messages for the exact target → `local_hold`
  (`reason: exact_target_pending`); an existing boundary → `forward`; otherwise, when the target
  already carries recent context, `syncing_hold`
  (`reason: target_first_touch_recent_context`, first touch).
- The local draft is `{content, attachmentIds, mentions, savedAt, reholdCount, seenUpToSeq}`
  (`continue-state.json`, **L753176-753240**), and `--send-draft` replays it; `--anyway` requires
  `--send-draft` (`validateDraftSendFlags`, **L753401**); the recovery text is
  `formatFreshnessHoldOutput` (**L807414**).

The observable defect of the token design is that the Agent's own state is not what decides: a
re-held draft could not be forced once its token expired, and the CLI could not report Raft's
`decision`/counts because the server never sent them.

## Decision

1. The Agent-API send request and its response use Raft's field names and shapes verbatim: `content`,
   `seenUpToSeq`, `draftReholdCount`, `draftReplacedExisting`, `continueAnyway` in;
   `state`/`decision`/`reason`/`producerFactId`/`availableActions`/`continueAnywaySuggested`/
   `heldMessages`/`newMessageCount`/`shownMessageCount`/`omittedMessageCount`/`seenUpToSeq` out.
2. The hold decision is Raft's planner, evaluated server-side for now: `bypass` for `continueAnyway`,
   `local_hold` for unconsumed context above the reported boundary, `syncing_hold` on a first touch of
   a target that already carries recent context, `forward` otherwise
   (`reason: model_seen_boundary` / `no_exact_target_pending_or_recent_context`).
3. `continueAnyway` is never refused. `continueAnywaySuggested` is `draftReholdCount >= 1` — Raft's
   own "this draft has already been held once" signal.
4. `--send-draft` replays the daemon-held copy: the daemon stores
   `{content, reholdCount, attachmentIds, mentions}` and reports `draftReholdCount`; piped content
   with `--send-draft` is refused (`SEND_DRAFT_STDIN_UNSUPPORTED`), as Raft does.
5. The server-side hold store and its token are deleted, together with the `denied` state.
6. The CLI renders Raft's held notice (`Held — N unread messages in <target>. …`, the bounded window
   with its omitted-earlier-messages note, `After reviewing the current state of this conversation,
   choose one path.`, and the `--send-draft --anyway` escape only when suggested).

## Consequences

- An Agent's decision material is what Raft gives it: a named decision, a reason, counts, and the
  recovery actions. `--anyway` no longer depends on a server token's TTL.
- Deleting the token means the server no longer needs Redis for holds; the daemon owns draft state
  (it already owned the read boundary).
- **Landed after this ADR was written** (task #58, tracked here rather than in a changelog): the
  daemon-side decision (`#524`/`#534` — a locally decided hold is terminal and never issued), the
  draft's Raft file shape and `seenUpToSeq` (`#537`), the held-window bound (`#535`), and the
  freshness-decision activity projection (its own follow-up PR, `projectApmHeldFreshnessActivity`,
  bundle **L812425**: `detailKind: "freshness_hold"`, `Send held by freshness check`, and Raft's
  `producerFactId`).
- **PR 2 of task #58 (the reason this item was once "still to land"):** Raft decides the hold inside the computer/daemon
  (`planAgentInboxSideEffect` + a local `freshness_hold` response, bundle **L816274**), while CoForge
  still decides it in the server. This ADR fixes the contract and the semantics; moving the decision
  into the daemon's inbox state machine, and projecting the freshness decision into Agent Activity
  (`projectApmHeldFreshnessActivity`, bundle **L812425**; `detailKind: "freshness_hold"`,
  `Send held by freshness check`), are the next steps.
- **Inference, not binary-read:** Raft's *server-side* hold rule is not in the computer bundle, so
  item 3 (`continueAnywaySuggested = draftReholdCount >= 1`) and the exact `syncing_hold` trigger are
  inferred from the planner's client side plus the wire schema; the corroborating newer source
  (`server/internal/daemon/message_send_proxy.go`) was used only as supporting evidence, never for
  field names.

## Addendum (2026-09-21, task #58 ④): the send body's field names

Raft's send contract carries **`idempotencyKey`** — the name its body schema gives the request's
idempotency key (`agentApiSendBodyKnownSchema`, bundle **L16728**, in the v1 *and* v2 schema alike).
CoForge called the same key `requestId`, and the idempotency key is exactly what makes a retried send
one message instead of two, so the name matters more than it looks.

- **The body is Raft's, and it travels on our own route.** The daemon posts to
  `POST /api/agent/v1/messages` (`agentApiRoutes.cloud.messages.send`) with `idempotencyKey`,
  `target`, `content`, `continueAnyway`, `sendDraft`, `draftReholdCount`, `draftReplacedExisting`,
  `seenUpToSeq`, `freshnessContextMode`, `attachmentIds`, `mentions`. CoForge **does not adopt
  Raft's `/v2/send` route**: the route is ours, the body is his.
- **One spelling, not two.** `idempotencyKey` is the only name the server reads; `requestId` is not
  accepted alongside it, so one request cannot be deduplicated under two keys (the alternative —
  accepting both while Computers and the server upgrade independently — was considered and
  rejected).
- `sendDraft` is carried for the first time (the server already understood it; the daemon never sent
  it), which is what marks a resend of a held draft as one.
- Raft's schema also declares `continue` (1.0.32 **L16724**). Its own CLI never sets it and its
  semantics are unverified, so CoForge neither sends nor interprets it; the force-send flag is
  `continueAnyway`, as in Raft.
