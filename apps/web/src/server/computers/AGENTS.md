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
