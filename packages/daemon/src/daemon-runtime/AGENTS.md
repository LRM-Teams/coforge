# daemon-runtime instructions

Rules for one Workspace child's runtime in `src/daemon-runtime/`. They extend
`packages/daemon/AGENTS.md`.

## Boundary

- This directory owns one Workspace child's cloud-facing use cases and Agent
  runtime operations. The machine Coordinator is in `supervisor/`; transport
  mechanics are in `connection/`.
- It coordinates the acknowledged cloud `agent:session` report for the current
  Workspace daemon and Agent launch, and keeps only volatile acknowledged
  identity and launch references for already-authorized wakes.
- A launch this runtime initiates itself follows the launch-identity rules in
  [`agent-runtime/AGENTS.md`](../agent-runtime/AGENTS.md).
- A start that fails stops its transport before replacing it, so a connection
  that came up never keeps reporting the Computer online for a Workspace that
  did not start. `stop` aborts a start still waiting on the cloud (connect or
  first ready).
- A deliberate `stop` sends the shutdown notice after its Agents are down,
  alongside (never ahead of) the Agent key revokes, and before the transport
  closes. Only a hold renewed within `SHUTDOWN_HOLD_REASON_WINDOW_MS` names
  the reason (`shutdown-reason.ts`); a stale or absent hold is
  `computer_stop`. Hold reasons are `RunnerHoldReason` values, never literals.
- Context-usage change detection lives here: skip an unchanged reading and
  forget the last reading on launch end or dispose. `connection/` only sends.

## Message attention and delivery

- `agent-message-attention-index.ts` owns full-target thread attention,
  model-visible positions, and the accepted-Message observation hook.
- A create or resume launch does not enqueue a synthetic first turn. Standing
  instructions are already on the session; the Agent waits for a real message
  or recovery notice.
- After a successful current-generation `notify`, ordinary live Message
  delivery and concrete wake/resume batches report `Message received` Activity
  with detail kind `message_received`, matching Raft Computer 1.0.32's
  `broadcastMessageReceivedActivity`. Summary-only recovery and deduplicated
  inputs do not report it.
- `runtime.ts` assigns launch and sequence metadata and publishes that
  best-effort Activity before the live delivery ACK. An observer failure must
  not reject accepted input.
- `runtime.ts` routes thread targets to the existing Agent session and
  canonicalizes short channel/DM thread targets. Threads never create sessions
  or processes.
- A delivery counts as consumed when its sequence is at or below its target's
  frontier, or is one of the target's exact seen sequences (Raft 1.0.38's
  `exactSeqs`: durable beside the frontier, at most 2500 per target, pruned as
  the frontier reaches them). A `check`, an anchored `read`, and a `read` the
  server does not call contiguous (`modelSeenUpToSeq: null`) record exact
  sequences only: no frontier, no read order. A `read` with a boundary moves
  the frontier there and reviews the target; one that found nothing only
  reviews it. The one inferred boundary is a held task result, which marks its
  newest inlined message model-seen. A send reports the exact sequences above its
  `seenUpToSeq` as `seenExactSeqs`; a sent response's `seenUpToSeq` (the server
  advanced over messages already seen) moves the frontier. A `search` never
  counts: it shows a truncated preview without whether the message mentions
  the Agent.
- The attention index is the consumed cursor's source of truth once it has
  read the file, and an operation that changed it writes one snapshot. A read's
  state is kept under its `consumptionScope.target` (a channel's top level is
  already canonical); the spelling the Agent used becomes an alias of it. A
  consumption scope for this Agent settles, in every other target of that
  conversation (and thread, matched by root whatever its case), only the
  messages the read returned.
- An untracked delivery is ACKed as soon as the daemon takes custody of it:
  when its notice is accepted, or when it is held for a later notice or launch
  (`AgentDeliveryQueue`, a failed launch's input queue). A delivery queued
  behind the runner hold of a Computer upgrade is not ACKed.
- An Agent with no process, no launch in progress, and no restart config
  takes no custody: its untracked delivery, and any a lifted runner hold left
  queued for it, is not ACKed but rejected over `agent:v1:message:reject` with
  reason `no_process`, and the server decides whether to start it. A delivery
  it has already consumed is still ACKed and dropped instead. A failed server
  Start leaves no daemon-side restart config or failure record.
- A tracked @mention delivery (it carries a `mentionDelivery` envelope) is
  settled by `mention-delivery-tracker.ts`, in memory only. It is ACKed, with
  its envelope echoed, only once drained: already consumed (whatever launch the
  envelope names), or told to the launch and native session the daemon last
  reported, at a moment the Agent is idle or in a turn that has ended. It is
  never held, never wakes an Agent, and never becomes `no_process`; otherwise
  the daemon reports a terminal error: `IDENTITY_DRIFT` (another Computer,
  launch or session), `INSTRUMENT_FAILED` (another message), `IDENTITY_UNKNOWN`
  (no running session, including during a launch or a pending server Start),
  `QUOTA_LIMITED` (rate-limit backoff), `UNSUPPORTED_DELIVERY_PATH` (a provider
  that takes notices only between turns, while busy), or `DELIVERY_REJECTED`
  (another backoff or the fence, a refused notice, a process gone before it
  accepted the notice, an inbox purge). Told during a turn, it stays pending
  until the turn ends, then is drained if the current session was told it and
  rejected otherwise; one named by `notice-undelivered` is settled instead by
  the redelivery of that notice (drained once accepted). A runner hold queues it
  unacknowledged; one still queued for an Agent without a session when the
  hold lifts is refused. Nothing is reported when a process exits.
- While a server Start is pending for such an Agent
  (`AgentControl.startPending`: from the `start` call through every
  launch-retry cooldown), its untracked deliveries are held, unacknowledged, instead of
  rejected. When the Start settles, a launched Agent receives them as ordinary
  deliveries; otherwise they are dropped unacknowledged and stay unread in the
  cloud.
- An inbox purge (`agent:v1:inbox:purge`) drops the waiting deliveries and
  pending attention of channels the Agent can no longer read, threads
  included; an untracked delivery it drops is ACKed, so a later rejoin does not replay it on
  `ready` (a Start still surfaces it as unread from the read boundary).
- Never launch an exited Agent for a delivery it has already consumed; ACK it
  instead.
- A failed message-triggered launch starts the per-Agent wake cooldown
  (`LaunchFailureBackoff`, no attempt cap); any successful launch ends it.
  Deliveries that wait for the next launch (in the cooldown, in a failed
  launch's input queue, or arriving while a batched wake launch is in flight)
  wait in `AgentDeliveryQueue`, already ACKed. The next launch presents them in
  one notice, or a server recovery notice covers them. `flush` gives them
  `receive`'s treatment (consumed, malformed). An explicit Stop, or a
  launch abandoned because its recovery notice was rejected, discards them;
  the next Start recovers them from the cloud read boundary.
- Thread follow state is cloud-persisted. The Daemon only forwards the Agent's
  explicit unfollow operation.

## Agent HTTPS forwarding

- Message sends: the per-target draft (`persistence/agent-message-draft-store.ts`)
  is the only local send state. It carries its send's `idempotencyKey`;
  `--send-draft` reuses it, and only that key's accepted send clears the draft.
  Never authorize `--anyway` locally.
- `agent-send-settlement.ts` settles one send: an ambiguous failure
  (pre-response or 5xx) gets one `reconcileAgentSend` and at most one same-key
  replay, never a blind retry. It sees the transport and the draft only through
  its ports; keep reconcile logic out of `runtime.ts`.
- `agent-send-verdict.ts` is the one shape for what the daemon judged about a
  failed request (`retryable`, `draftSaved`, `suggestedNextAction`).
  `agent-proxy-failure.ts` classifies the cause, then applies the verdict. A
  failed replay is retryable only while the draft still holds its key. A
  `MESSAGE_REQUEST_IN_PROGRESS` refusal is judged too: delivery unknown,
  retryable under the draft's key with `--expected-draft-key` while the draft
  still holds it. In both, once another send replaced the draft, or the draft
  cannot be read, the verdict is not retryable and names no resend command.
- Agent Task operations use the Credential Proxy and the authenticated Agent
  HTTPS connection. Task parsing and wire contracts belong to the SDK and CLI;
  claim/review applies to complex, coordinated, or already-shared Tasks, not
  ordinary requests, and that standing guidance lives once in
  `code-agent/agent-instructions.ts`.
- Apply the attention/model-visible preflight to Task `claim` and status
  `update` only; `amend` gets no local preflight. After the preflight, forward
  without storing Task state or interpreting claims, status transitions, or
  human approval. Reviewer-isolation holds expose counts only.

## Context report

- `scanAgentContext` resolves the launch and native session from daemon-tracked
  state, never from the request. It refuses a superseded launch without running
  the CLI. See [`code-agent/AGENTS.md`](../code-agent/AGENTS.md) for the
  report rules.

## Skills metadata

- Resolve the stable Agent directory and route Skills queries and results;
  never parse skill files here. That belongs to `code-agent/agent-skills.ts`.
