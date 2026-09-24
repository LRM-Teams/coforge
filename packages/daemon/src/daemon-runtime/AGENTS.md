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
- Context-usage change detection lives here: skip an unchanged reading and
  forget the last reading on launch end or dispose. `connection/` only sends.

## Message attention and delivery

- `agent-message-attention-index.ts` owns full-target thread attention,
  model-visible positions, and the accepted-Message observation hook.
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
- Never launch an exited Agent for a delivery it has already consumed or that
  would not wake a running Agent; ACK it instead.
- A failed message-triggered launch starts the per-Agent wake cooldown
  (`LaunchFailureBackoff`, no attempt cap). Deliveries in the cooldown wait
  unacknowledged in `AgentDeliveryQueue`; the first launch after it presents
  all of them in one notice and ACKs them only after that notice is accepted.
- Thread follow state is cloud-persisted. The Daemon only forwards the Agent's
  explicit unfollow operation.

## Agent HTTPS forwarding

- Held Message sends: keep only the draft text and the opaque Web/backend
  token. Never decide freshness, count hold stages, or authorize `--anyway`
  locally.
- Agent Task operations use the Credential Proxy and the authenticated Agent
  HTTPS connection. Task parsing and wire contracts belong to the SDK and CLI;
  the claim-before-work and acceptance workflow the Agent follows is stated
  once, in `code-agent/agent-instructions.ts`.
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
