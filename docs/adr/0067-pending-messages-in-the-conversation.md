# ADR 0067: The sender's pending messages show in the conversation

Status: Accepted
Date: 2026-09-23
Decided by: Frank

## Context

Before PR #683 the composer was disabled while a message was in flight and lost focus after each
send ("发送之后还得再点击一次才能继续发"). #683 kept the composer ready and held each submitted
message in a device-local outbox (`composer-outbox.ts`), but a message stayed invisible until the
server answered, and a failed one showed above the composer, away from the conversation.

Slack and Discord both show a sent message in the conversation immediately, greyed until the server
confirms it (Discord: [its reply on X](https://x.com/discord/status/843896802462109697); Slack:
user reports, e.g. [Hacker News](https://news.ycombinator.com/item?id=24688932)). The pending copy
must then be swapped for the real message. In CoForge the real message usually reaches the browser
first, through `message.available.v1` and the reconciliation read it triggers, because the server
publishes that signal before the send request returns. Without a shared key the page cannot tell
that the new message is its own pending one and shows both. Discord solves this with a client-chosen
`nonce` that its `MESSAGE_CREATE` event echoes
([Create Message](https://docs.discord.com/developers/resources/message)). Slack's message events
carry a similar `client_msg_id`.

## Decision

- `message.available.v1` gains an additive optional `requestId`: the send's existing idempotency
  key. It is set only for a person's send from the browser (direct message or channel, top level or
  thread reply). Agent, Task, and action-card messages leave it out. The event stays bodiless.
- The sender's page shows each submitted message at the foot of its conversation (or thread),
  greyed, until the real message is loaded. A realtime signal carrying the request id marks the
  outbox entry `delivered` as that message id; the pending row gives way only once that message is
  in the loaded window, so it never blinks out. A send response that fails after the signal
  arrived does not turn a delivered message into an unsent one.
- The combined design Frank approved (mockup, row "CoForge 方案"):
  - greyed with no label while sending (Discord);
  - "发送中…" added once a send is unconfirmed for 3 s (Slack's clarity, avoiding the reported
    "looked sent, wasn't" confusion);
  - normal with its time once the real message replaces it;
  - a failed send stays in place, greyed, with one plain sentence in red ("发送失败，请检查网络后重试")
    and only the actions that can help: Retry (same request id) when it may go through, Edit when a
    changed message could, and Delete always.
- The composer's "未发送" strip from #683 is removed; failures live in the conversation.

No database schema change: the request id travels only on the live signal. After a reload, an
interrupted send is matched by nothing and shows "可能没有发出去，重试不会重复发送"; retrying reuses its
request id.

## Consequences

- Other members' browsers receive the sender's request id and ignore it. It is a random id scoped to
  the sender by the idempotency key (`workspace:senderKind:senderId:requestId`), so it cannot be
  used to replay or claim anyone else's send.
- The request id is idempotent for 24 h (`RESULT_TTL_SECONDS`). Retrying an interrupted message
  that did arrive more than a day earlier would post it again.
- A failed send stays visible even while the main pane is scrolled back to older messages, drawn at
  the foot of that window, so a failure cannot go unseen; pending rows wait for the latest window.
- A sender's page that is not subscribed to the conversation (the reader moved elsewhere) relies on
  the send response alone, as before.
