# Agent attention and recovery

The current MVP has no complete per-Agent delivery-ledger table and no local
durable message inbox/outbox. The canonical `Message` plus each conversation
member's read boundary is the recovery model. A daemon ACK means only that
`AgentSession`/`notify` successfully accepted the volatile attention; it
does not mean an Agent run completed. Agent read/send uses the independent
HTTPS RPC, and a logical send retries the same `request_id` after an uncertain
result. Agent Activity is a best-effort observation and has no local spool or
database recovery role.

A daemon `ready` replays every still-unacknowledged `AgentMessageDelivery`
except those of a channel the Agent no longer actively belongs to (its
membership has `leftAt` set); direct-message deliveries always replay. When an
Agent leaves a channel, is removed from one, or goes private, the server also
publishes a best-effort `AgentInboxPurge` on its daemon control channel so the
daemon drops what it still holds for those channels. A missed purge is covered
by the replay rule, not retried.
