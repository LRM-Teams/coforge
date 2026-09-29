# Computer server modules

These rules apply to `src/server/computers/`.

- `computer-metadata.server.ts` persists last-observed OS and executable
  metadata. The Daemon `ready` message supplies observations only, never
  creator identity.
- A Computer-scoped creator avatar download authorizes Workspace membership
  before resolving the original Computer owner and reading the User avatar
  store.
- `computer-http.server.ts` binds the fixed `/api/computer/workspace` and
  `/api/computer/attach` routes to `workspace:get` and `computer:register`.
  It is composition only; `ComputerRegistrar` owns registration authorization,
  idempotency, and persistence.
- A flow that removes a Computer from a Workspace calls
  `DaemonCredentialRevocations.recordForComputer(tx, {workspaceId, computerId})`
  inside its transaction, before anything revokes or cascades those daemon
  keys, so the Computer parks that binding with `computer_unlinked`. Deleting a
  Computer row or its owner cascades the keys without a record: those
  Computers get the ordinary retryable failure. Add a record there too when
  such a delete path is built.
