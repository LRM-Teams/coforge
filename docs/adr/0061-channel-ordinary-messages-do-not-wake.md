# ADR 0061: Ordinary channel messages do not wake an Agent

Status: accepted
Date: 2026-09-21

## Context

Every accepted `AgentMessageDelivery` used to call `session.notify()`. In an unmuted
`#general`, ordinary chatter therefore started a full turn: the Agent reread standing
instructions and MEMORY.md, ran `coforge message check`, and wrote the bodies into the
transcript. That is the main source of useless wakeups (see
`/home/jianghp3/coforge-context-optimization-plan.md` §1).

The server already narrows _who_ is delivered to: a human message that @mentions at least
one Agent is directed at those Agents (and pierces mute); otherwise every unmuted Agent
member is delivered. Delivery is not the same as a model wakeup. New Agents also joined
`#general` unmuted, so the first idle workspace already woke them on every post.

## Decision

1. `AgentMessageDelivery` carries `mentionsAgent`. The Web sets it from the stored mention
   rows (`deliveryMentionsAgent`). An older Web that omits the field leaves the daemon on
   the previous wake-everyone path.
2. `AgentMessageAttentionIndex.receive()` still records attention / pending window / latest
   and ACKs immediately for a parent-channel delivery that is not a personal @mention and
   not `system`. It does **not** `notify` and does **not** enqueue on the busy hold queue.
   DM, channel threads, system messages, and `mentionsAgent: true` keep the existing notify
   / hold path.
3. After a turn `completed`, `digestSilent()` may send one coalesced inbox notice for the
   silent targets, no more often than every 30 minutes. A later DM / mention notice also
   lists those targets as `held` (the existing `#localViewRows` hitch-hike).
4. `enrollGeneralChannel` writes `channelMuted: true` for Agent members. Existing rows are
   unchanged (`skipDuplicates`). Humans are unchanged. Mentions still pierce mute.
5. `formatMessageLine` keeps full text when `mentionsAgent` is true (P1 truncated every
   plain-channel line).

## Rejected alternatives

- Muting `#general` only, without daemon-side silence: an Agent that unmutes would still
  wake on every post.
- Dropping channel deliveries entirely: `check` / recovery unread would lose ordinary
  posts the Agent can still choose to read.
- Digest on a timer while idle: no completed event, and a timer would reintroduce
  unsolicited wakeups.

## Consequences and migration

- New Agents stop receiving ordinary `#general` deliveries until unmuted. Tests and live
  E2E that wake an Agent through `#general` must unmute or @mention.
- Prompt text now says Agents join `#general` initially muted.
- Rollback: revert the proto field (default `false` is backward compatible on the wire)
  and the `receive()` branch; existing muted Agents stay muted until someone unmutes.

## Validation and rollback

- Daemon tests: ordinary channel → ACK and no notice; mention / DM → notice; digest after
  30 minutes only; MEMORY.md reminder appended once.
- Web: new Agent `channelMuted === true`; unmute restores ordinary delivery.
- Rollback criterion: `agent.inbox_notice.accepted` per Agent per day returns to the
  pre-change baseline.
