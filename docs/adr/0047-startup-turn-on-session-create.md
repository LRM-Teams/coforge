# ADR 0047: A launch that creates a new session opens with a startup turn

Status: accepted
Date: 2026-09-18

## Context

The standing Agent instructions (`packages/daemon/src/code-agent/agent-instructions.ts`, including
`## Startup sequence`) are loaded natively by every provider:

- claude-code writes them to a prompt file;
- codex passes them as `developerInstructions`;
- pi passes them as `instructions`;
- kiro writes them into its `.kiro/agents/<name>.json` profile.

None of these runs a turn. Before this change, the daemon started a turn only when the launch
carried recovery context (a wake message, resume messages or an unread summary). A newly created
Agent had none, so it sat idle after spawn.

With no turn, there is no turn end and no `idle` Activity. The `starting` Activity therefore
stayed visible until the server's liveness sweep (ADR 0020) probed the Agent, about 90 s later,
or until the first message arrived.

Staging example, Agent `aafc90ec…` on s144, 2026-09-18 (UTC):

| Time | Activity |
| --- | --- |
| 06:35:16 | `starting` |
| (91 s) | nothing |
| 06:36:47 | `message_received` |
| 06:37:36 | `idle` |

## Decision

When all of the following hold, the daemon queues one input, `Start.`
(`AGENT_STARTUP_TURN_TEXT`), as that launch's first turn:

- the launch is explicitly `sessionMode: "create"`;
- it carries no wake message, resume messages or unread summary.

A launch is `create` in these cases:

- The server marks every Start that does not resume a used session as `create`:
  - a new Agent;
  - Reset session;
  - Full reset;
  - a session that never ran a turn.

  See `agent-control.server.ts` `publishCurrent` and `agent-sessions.server.ts` `prepare`.
- The daemon's own fresh-session retry after a failed resume is `create` too. This covers
  `session_missing` and `provider_replay_rejected` in `agent-control.ts`. Before this change, that
  retry dropped `sessionMode` entirely.

The input is queued ahead of any message that arrives while the process is still starting. The
provider then runs its Startup sequence, and the turn end reports `idle` through the existing
path.

Rules:

- **Unknown is not create.** Resume launches and daemon-initiated wakes carry no `sessionMode`
  and get no startup turn. The daemon-initiated wakes are a message delivery, an App item, or
  `AgentControl.wake`.
- **One first input.** A launch that carries recovery context delivers only that context.
- **Not awaited.** Neither the launch nor the Start result reported from it waits for the
  turn. A turn can exceed a minute, while the server waits only about 7 s for a Start result
  (`AgentControl.drive`, `timeoutMs: 7_000`) before returning the operation to the caller as
  still starting. Waiting on the turn would hold every such Start in "starting" for the length
  of a model turn.
- **Stop wins.** A Stop during launch closes the input queue and drops the queued turn.
- **Refusal is the provider's.** A refused input is logged as `agent.startup_turn.rejected`. The
  launch is not rolled back. Kiro, for one, disposes its session, and the process exit is
  reported through the ordinary exit path.
- **No per-provider switch.** All current providers load instructions natively, so every
  provider gets the same neutral `Start.`.

Cost: one extra model turn for each new Agent, Reset session, Full reset, and failed-resume
retry.

## Comparison

Raft Computer 1.0.32 always gives a spawn a first input:

| Case | First input |
| --- | --- |
| Wake or inbox | the concrete messages |
| Resume, no new messages | `formatResumeEmptyPrompt` |
| Cold start | the standing prompt, or `"Start."` (`NATIVE_STANDING_PROMPT_STARTUP_INPUT`) for drivers with a native standing prompt |

Raft's fallback after a failed resume clears the session ID and relaunches. That launch is no
longer a resume, so it takes the cold-start input.

CoForge adopts the cold-start rule, including that fallback. It does not adopt the resume prompt:
a resume launch still waits for real input.

## Consequences

- A new Agent goes from `starting` to `idle` after its first turn, instead of waiting for the
  90 s sweep. The sweep stays as the safety net.
- The Startup sequence actually runs at start: read `MEMORY.md`, then stop if there is no work.
- Owed after release: on s144, create an Agent without messaging it, and confirm it reaches Online
  within seconds.
