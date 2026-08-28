# ADR 0005: Stateless Computer setup bindings

Status: accepted

## Decision

Setup persistence owns exactly four PostgreSQL models: `Workspace`,
`WorkspaceMembership`, `Computer`, and `WorkspaceComputer`. The latter stores
the durable workspace/computer binding and stable worker identity (`id`). It
does not store a worker token, token hash, idempotency key, claim, or temporary
registration state.

`WorkspaceComputer(workspaceId, computerId)` and
`Computer(ownerUserId, machineId)` are unique database constraints. The
repository uses upsert and explicit unique-conflict handling to make retries
idempotent. `ComputerRegistrar` always issues a new stateless JWT after finding
or creating the binding; a retry is therefore safe and does not need the prior
token.

## Consequences and limitation

Database uniqueness prevents duplicate durable rows under concurrent setup.
Without a separate idempotency record, request-level response replay and
cross-process waiting are intentionally not provided. A failure after the
binding commit but before JWT issuance is safe to retry, while callers may
receive different JWTs. The final migration is generated from the Prisma
schema with Prisma Migrate; `db push` is not part of this design.
