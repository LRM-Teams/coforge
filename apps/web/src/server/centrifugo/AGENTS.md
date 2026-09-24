# Centrifugo transport

These rules apply to `src/server/centrifugo/`. Centrifugo owns transport
mechanics only; domain rules stay in the owning `src/server/` module.

- Receivers authenticate the connection claims before applying any
  conditional Session or control update.
- Fire-and-forget receivers (Session invalidate, context usage) answer 403 on
  any rejection. Keep that wire response unchanged; log a genuine failure with
  an allowlisted reason, as `agent_control:result_rejected` and
  `agent_session:snapshot_rejected` do.
- The context-usage receiver accepts a reading only when
  `AgentControlState.launchId` matches the message's own. It writes the
  display read model (`agent-display.server.ts`), never the control record.
- `agent-skills-cache.server.ts` stores short-lived, request-scoped results,
  not inventory or canonical data.
- `agent-context-cache.server.ts` stores the last validated report per Agent
  with the usage cache's retention and freshness rules.
  `createAgentContextScanResultMethod` validates report bytes at the boundary.
