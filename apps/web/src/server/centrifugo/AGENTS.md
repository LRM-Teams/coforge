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
- The connect proxy refuses a Daemon for good only with an HTTP 200
  `disconnect` in Centrifugo's terminal 4500-4999 range, using the SDK's
  `DAEMON_CONNECT_REJECTION_CODES`: `computer_unlinked` for a valid key whose
  Computer is no longer linked to its Workspace, and the recorded reason for a
  formerly valid key that has a `DaemonCredentialRevocations` record. Any other
  failure, including an unknown key, stays a non-200 answer, which Centrifugo
  turns into a temporary error the Daemon retries. Never tell a caller about a
  Workspace it holds no formerly valid key for.
- Who records a revocation: Workspace deletion
  ([`../workspaces/AGENTS.md`](../workspaces/AGENTS.md)) and Computer removal
  ([`../computers/AGENTS.md`](../computers/AGENTS.md)). Every refusal logs
  `daemon_connect:refused` with its reason.
