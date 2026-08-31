# ADR 0005: Stateless Computer setup bindings

Status: accepted

## Decision

Setup persistence owns exactly four PostgreSQL models: `Workspace`,
`WorkspaceMembership`, `Computer`, and `WorkspaceComputer`. The latter stores
the durable workspace/computer binding. Its database `id` is an internal
storage primary key, not a business identity. The business identity is the
composite `(workspaceId, computerId)` key. It does not store a worker token,
token hash, idempotency key, claim, or temporary registration state.

`WorkspaceComputer(workspaceId, computerId)` and
`Computer(ownerUserId, machineId)` are unique database constraints. The
repository uses upsert and explicit unique-conflict handling to make retries
idempotent. `ComputerRegistrar` issues a new revocable Daemon API key after
finding or creating the binding; a retry is therefore safe and replaces the
previous key.

## Consequences and limitation

Database uniqueness prevents duplicate durable rows under concurrent setup.
Without a separate idempotency record, request-level response replay and
cross-process waiting are intentionally not provided. A failure after the
binding commit but before API-key issuance is safe to retry, while callers may
receive different keys. The final migration is generated from the Prisma
schema with Prisma Migrate; `db push` is not part of this design.
