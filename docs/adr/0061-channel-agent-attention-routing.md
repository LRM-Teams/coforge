# ADR 0061: Channel Agent attention routing

Status: accepted
Date: 2026-09-21

## Context

Public channels need two different behaviors:

- ordinary human channel messages are ambient team context; delivered Agents should wake, inspect,
  and decide whether a reply is useful;
- Agent-authored channel messages must not create Agent-to-Agent reply loops. An Agent should wake a
  peer only by explicitly @mentioning that peer.

The server already narrows delivery for explicit Agent mentions: if a channel message @mentions one
or more Agents, only those Agents receive a delivery and the mention pierces mute. Without an Agent
mention, every unmuted Agent member is eligible for human channel messages.

The previous built-in `#general` channel is also removed from automatic Workspace/member/Agent
creation in this change: channel membership should be explicit, not a hidden default that wakes
Agents by virtue of existing.

## Decision

1. `AgentMessageDelivery` carries optional `mentionsAgent`. The Web sets it from stored mention
   rows (`deliveryMentionsAgent`). Optional presence preserves both explicit `true` and explicit
   `false`; omission keeps backward-compatible wake behavior.
2. Human-authored ordinary channel deliveries wake the delivered Agents. The model-visible notice is
   still body-free; Agents can run `coforge message check` / `read` and choose whether to respond.
3. Agent-authored parent-channel deliveries with `mentionsAgent: false` are recorded and ACKed, but
   do not notify the recipient. Agent-authored `@Agent` deliveries keep the normal notify path, so
   explicit handoffs wake exactly the mentioned Agent(s).
4. Workspaces, invited members, newly created Agents, and weekly-report Agents are no longer
   auto-enrolled into a built-in `#general` channel. A migration archives existing `#general`
   conversations instead of deleting them: the implicit ambient channel becomes read-only/hidden by
   normal navigation, while message history, Tasks, Action cards, attachments, deliveries, and
   reminder targets remain available for audit/history.
5. `formatMessageLine` keeps full text when `mentionsAgent` is true; ordinary plain-channel lines may
   remain summarized to save context.

## Rejected alternatives

- Suppressing every ordinary parent-channel delivery in the daemon: this prevents human group chat
  from reaching Agents that should choose whether to participate.
- Letting Agent-authored ordinary channel messages wake peers: this risks Agent reply loops and noisy
  cross-Agent chatter.
- Adding a timed digest for silent Agent-authored channel messages: those messages are deliberately
  non-interrupting. Agents can still inspect channel history with `coforge message check` / `read`
  when they next have a real reason to wake.

## Consequences and migration

- Ordinary human messages in joined, unmuted channels continue to wake delivered Agents.
- Agent-to-Agent channel handoffs must use explicit @mentions.
- Agent-authored ordinary channel messages can still be read from channel history, but they do not
  create a daemon wakeup by themselves.
- There is no default active `#general` channel after migration; teams create/join the channels they
  want explicitly. Legacy `#general` rows, if present, are archived rather than deleted so human work
  records are preserved.
- Long ordinary parent-channel lines may be summarized in `formatMessageLine`, but lines that
  personally @mention the reading Agent keep full text.
- Rollout must deploy the code that stops creating/enrolling `#general` no later than this migration.
  If an old writer creates a fresh `#general` during rollout, rerun the archive statement for that
  workspace before considering the default channel retired.

## Validation and rollback

- Daemon tests: human ordinary channel delivery wakes; Agent ordinary channel delivery ACKs silently;
  Agent @mention wakes; MEMORY.md reminder appends once.
- SDK tests: both `mentionsAgent: true` and `mentionsAgent: false` round-trip on the wire.
- Rollback: remove the Agent-authored silent branch and ignore `mentionsAgent` in daemon attention.
  Data rollback is non-destructive: unarchive a legacy `#general` conversation only if the product
  decision is to restore that default channel for the affected Workspace.
