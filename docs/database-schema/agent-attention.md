# Agent attention and recovery

The current MVP has no complete per-Agent delivery-ledger table and no local
durable message inbox/outbox. The canonical `Message` plus each conversation
member's read boundary is the recovery model. A daemon ACK means only that
`AgentSession`/`notify` successfully accepted the volatile attention; it
does not mean an Agent run completed. Agent read/send uses the independent
HTTPS RPC, and a logical send retries the same `request_id` after an uncertain
result. Agent Activity is a best-effort observation and has no local spool or
database recovery role.
