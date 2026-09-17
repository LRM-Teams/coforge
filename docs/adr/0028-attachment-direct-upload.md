# ADR 0028: Presigned direct upload for `coforge attachment upload`

Status: accepted
Date: 2026-09-17

## Context

Raft Computer 1.0.32 supports a presigned "direct upload" path for `raft attachment upload`:
above a server-advertised size threshold, the CLI PUTs the file straight to object storage using
a short-lived signed URL instead of proxying the bytes through the server as a multipart POST.
[ADR 0023](0023-agent-attachment-upload.md) added the multipart-only path and explicitly deferred
this ("Direct/presigned upload stays deferred"), leaving
`attachmentCapabilities().directUploadEnabled` hardcoded `false`. This record adds the deferred
half: `FileStorage` gains the two operations a presigned flow needs (`head`, to verify a completed
PUT without downloading it; `presignPut`, to mint the signed URL), a new
`attachment_upload_sessions` table holds the pending→completed state machine between "session
created" and "server-verified attachment," four new Agent HTTP routes and a matching daemon-proxy
forwarding path carry that state machine, and the CLI's `attachment upload` command gains the
Raft-parity client flow while keeping its existing command line and success output unchanged.

Another Agent, on a different branch (`feat/attachment-multi`), is concurrently changing which
fields `Attachment` carries per message; this record does not anticipate that work and is built
directly against `origin/main` as it stood after
[PR #292](https://github.com/LRM-Teams/coforge/pull/292) ("Agent attachment upload") merged.

## Decision

1. **`FileStorage` gains `head` (required) and `presignPut` (optional).**
   `apps/web/src/server/files/file-storage.server.ts`'s port interface adds
   `head(objectKey): Promise<{ sizeBytes: number; contentType: string | null } | null>`
   (implemented by both backends) and
   `presignPut?(objectKey, { contentType, expiresInSeconds }): Promise<{ url: string; headers:
   Record<string, string> }>` (implemented only by `OssFileStorage`; `LocalFileStorage` has none).
   `attachmentCapabilities(storage, env?)`'s signature changes to accept the storage port —
   `directUploadEnabled` is now computed as `typeof storage.presignPut === "function"` rather than
   a hardcoded `false` — and an optional `env` for the new threshold below; every existing caller
   and test that built a bare `{ put, open, remove }` fake for `FileStorage` needed a `head` added
   to keep compiling (`apps/web/test/attachments.test.ts`, `apps/web/test/file-storage.test.ts`,
   `apps/web/test/project-images.integration.ts`), and the one existing capabilities unit test
   changed its call shape and its expected `directUploadThresholdBytes` (see "Validation" below).
2. **OSS's own no-overwrite conflict, not Raft's `If-None-Match`.** `OssFileStorage.presignPut`
   V4-signs a PUT with `Content-Type` and `x-oss-forbid-overwrite: true` (`ali-oss`'s
   `signatureUrlV4`; consulted via the `find-docs` skill). OSS has no S3-style
   `If-None-Match: *` precondition; `x-oss-forbid-overwrite` is the OSS-native equivalent, and a
   conflict on it answers HTTP `409 FileAlreadyExists` (confirmed against this repo's own fake-OSS
   test fixture in `file-storage.test.ts`, which already modeled this for the existing `put()`
   path), not Raft 1.0.32's `412`. The session `complete` route and the CLI's PUT-outcome check
   both treat `409` as "the object already exists" (an idempotent replay), matching Raft's
   *behavior* while adapting its *status code* to what this storage backend actually returns.
   Neither header needs to be listed in `signatureUrlV4`'s `additionalHeaders` parameter:
   `ali-oss`'s V4 signer always folds `content-type` and every `x-oss-*` header already present
   into the canonical request, and explicitly strips those same headers back out of whatever
   `additionalHeaders` list is passed — so passing one would be a no-op.
3. **A new `attachment_upload_sessions` table (one generated Prisma migration,
   `20260917025131_attachment_upload_sessions`), generated against an isolated local Postgres
   database cloned from the shared dev database's migration history (not the shared dev database
   itself, which another Agent's concurrent branch had already drifted with unrelated
   migrations) — the generated migration carries no unrelated drift and is committed exactly as
   generated.** Columns: `id` (uploadId), `workspaceId`, `conversationId`, `agentId`,
   `attachmentId` (reserved ahead of the `Attachment` row it becomes on `complete` — not a foreign
   key, since that row does not exist until verification succeeds — unique), `objectKey` (unique),
   `fileName`, `contentType`, `sizeBytes`, `clientRequestId`, `state` (plain `String`, matching
   this schema's existing convention for status fields such as `Reminder.status`, not a Prisma
   enum), `terminalReason` (nullable), `expiresAt`, `createdAt`, `updatedAt`; `@@unique([agentId,
   clientRequestId])` for idempotency; FKs to `Workspace`/`Conversation`/`Agent` cascade on delete,
   matching `Attachment`'s own FK pattern.
4. **Four new Agent HTTP routes, JSON in and out, mirroring the shape of the existing ones.**
   `POST /api/agent/v1/attachment-upload-sessions` (create), `POST
   .../attachment-upload-sessions/:uploadId/complete`, `DELETE .../attachment-upload-sessions/:uploadId`
   (cancel), `GET .../attachment-upload-sessions/:uploadId` (status) — four new
   `routes/api/agent/v1/attachment-upload-sessions/*.ts` files (`index.ts`, `$uploadId.ts` for
   GET/DELETE, `$uploadId.complete.ts` for POST), each behind `agentAuthMiddleware`. `create`'s
   request body field is `target` (this repo's `#channel`/`@user` grammar, resolved through the
   same `resolveAgentTarget` the multipart route already uses), not Raft's resolved `channelId` —
   CoForge has no bare channel-id concept exposed to an Agent, exactly the same deviation ADR 0023
   already made for the multipart route. Errors are `{ error, code, retryable, retryAfterMs? }`,
   matching Raft 1.0.32's error codes (`UPLOAD_INVALID_REQUEST` 400, `UPLOAD_FORBIDDEN` 403,
   `UPLOAD_IDEMPOTENCY_CONFLICT` 409, `UPLOAD_TOO_LARGE` 413, `UPLOAD_OBJECT_NOT_FOUND` 404
   retryable, `UPLOAD_VERIFICATION_IN_PROGRESS` 409 retryable, `UPLOAD_SESSION_EXPIRED` 410,
   `UPLOAD_OBJECT_MISMATCH` 422, `UPLOAD_SESSION_NOT_FOUND` 404) with one intentional
   simplification: Raft additionally has `UPLOAD_RATE_LIMITED` (no rate-limiting layer exists
   anywhere in this codebase yet, Agent-facing or otherwise, so nothing would ever raise it) and
   `ATTACHMENT_ALREADY_CONSUMED` on `cancel` (Raft tracks whether a completed upload has since
   been attached to a sent message on the session row itself; this repo already authorizes every
   `Attachment` read/send through the ordinary conversation-membership checks regardless of which
   path created it, so `cancel` on an already-terminal session is simply a no-op that reports the
   current state rather than a new failure mode).
5. **`create`/`complete` implement Raft's state machine exactly, adapted to this schema's
   idempotency mechanics.** `create` looks up `(agentId, clientRequestId)`; an exact match on the
   other fields while the existing session is still `pending` re-signs and returns the same
   session (Raft's "same key + same body → same session"); a parameter mismatch is
   `UPLOAD_IDEMPOTENCY_CONFLICT`; and — since a session past `pending` (verifying, completed,
   canceled, expired, failed) has nothing left to (re-)sign — replaying a matching key against one
   of those is *also* `UPLOAD_IDEMPOTENCY_CONFLICT` (`clientRequestId was already used by a
   session that is now <state>; start a new upload`) rather than fabricating a fresh `pending`
   reply with an empty upload URL, which the CLI would otherwise PUT to. A `create` race on the
   same key is caught as a Prisma `P2002` unique-constraint violation and folded into the same
   replay path.
   `complete` claims verification with a conditional `UPDATE ... WHERE state = 'pending'` (not a
   separate lock), so a concurrent `complete` call loses the race and gets
   `UPLOAD_VERIFICATION_IN_PROGRESS`; it then `head`s the object, and on a match creates the
   `Attachment` row (reusing the reserved `attachmentId`, `uploaderAgentId` set exactly as
   `storeAgentAttachment` already does) and marks the session `completed` inside one
   `db.$transaction`; completing an already-`completed` session is idempotent and returns the same
   attachment; an expired session (past `expiresAt`) answers `UPLOAD_SESSION_EXPIRED` and
   best-effort deletes the object; a size mismatch answers `UPLOAD_OBJECT_MISMATCH`, deletes the
   object, and marks the session `failed` with a `terminalReason`.
6. **The daemon-local proxy forwards these four routes as plain JSON**, unlike the existing
   multipart-upload forwarding (which never parses its body as JSON at all).
   `packages/daemon/src/agent-proxy.ts` adds two route shapes ahead of the generic
   `agent:message`-style JSON dispatch: the fixed `create` path, and a `/:uploadId[/complete]`
   prefix shared by `complete`/`cancel`/`get`, each forwarded to a new optional
   `runtime.agentAttachmentUploadSessionCreate/Complete/Cancel/Get` method — mirroring
   `agentAttachment`/`agentAttachmentUpload`'s existing shape exactly. `DaemonRuntime`
   (`daemon-runtime/runtime.ts`) authorizes the local context then delegates to the transport;
   `DaemonConnection` (`connection/daemon-connection.ts`) forwards to the matching
   `agentApiRoutes.cloud.attachmentUploadSessions.*` route with the same Agent-scoped headers
   every other forwarded route already adds. `packages/daemon/index.ts`'s runtime wiring gains the
   four methods.
7. **The SDK route contract and client types grow in place**, following ADR 0023's own
   precedent: `agentApiRoutes.{local,cloud}.attachmentUploadSessions.{create,complete,cancel,get}`,
   and `AgentApiClient`/`RawAgentApiClient` gain a structurally symmetric
   `attachments.uploadSessions.{create,complete,cancel,get}` next to the existing
   `attachments.upload`.
8. **`coforge attachment upload`'s command line, local preconditions, and success output are
   unchanged.** All of the new logic lives inside `local-client.ts`'s `callAttachmentUpload`:
   after the existing capabilities lookup (which now also reports `directUploadEnabled` and
   `directUploadThresholdBytes` from `COFORGE_ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES`, default
   1 MiB, read regardless of whether direct upload is enabled — the server always knows its own
   threshold even when this backend cannot act on it), a file at or above the threshold on a
   direct-upload-capable server runs the session flow: create → PUT the bytes with `Bun.file(path)`
   as the body (a `Blob`, so `fetch` sets a real `Content-Length` from its known size and streams
   it from disk itself, with no `Transfer-Encoding: chunked`; a `ReadableStream` body has no known
   length and would be sent chunked instead, which OSS's PutObject does not accept in place of a
   real `Content-Length` — verified with a `Bun.serve` fake asserting the header Bun's `fetch`
   actually sends) — one retry on a thrown network error or a `408`/`429`/`5xx` response; any
   other non-2xx is a definite failure that cancels the session
   before reporting `UPLOAD_OBJECT_PUT_FAILED`; a `409` or an ambiguous network failure after the
   one retry falls through to `complete` without canceling, exactly as Raft's own client does for
   its `412`/unknown-outcome cases) → `complete` (retried up to 3× with `250ms × attempt` backoff
   on `UPLOAD_OBJECT_NOT_FOUND`/`UPLOAD_VERIFICATION_IN_PROGRESS`). A file below the threshold, or
   any server that does not advertise `directUploadEnabled`, uses the existing multipart path,
   factored out unchanged into its own local closure. Both paths return the identical
   `{ id, fileName, contentType, sizeBytes }` shape, so neither `index.ts`'s CLI command parsing
   nor its text/`--json` output needed to change.

## Rejected alternatives

- **Signing `additionalHeaders` explicitly for `x-oss-forbid-overwrite`.** Rejected after reading
  `ali-oss`'s V4 signer source: it already folds every `x-oss-*` header (and `content-type`) into
  the canonical request unconditionally, and strips exactly those headers back out of any
  `additionalHeaders` list passed in, so passing one would be dead code.
- **Treating a presigned-PUT conflict as HTTP `412`, matching Raft literally.** Rejected: this
  repo's storage backend (Alibaba Cloud OSS) has no `If-None-Match` precondition to presign
  against; its own no-overwrite mechanism (`x-oss-forbid-overwrite`) answers `409`, confirmed
  against this repo's existing fake-OSS test fixture. Keeping Raft's exact status code would mean
  building a `412` on top of a header OSS does not honor, silently defeating the no-overwrite
  guarantee.
- **A separate `UPLOAD_RATE_LIMITED` code and rate-limiting layer, and `ATTACHMENT_ALREADY_CONSUMED`
  tracking on `cancel`.** Rejected for this record: no Agent-facing route in this codebase is
  rate-limited today, and this repo's message-send path authorizes attachment access through
  ordinary conversation membership regardless of upload path, so a session-level "already
  consumed" flag would duplicate an authorization check that already exists elsewhere.
- **Generating the migration against the shared local dev Postgres database directly.** Rejected:
  another Agent's concurrent branch had already applied unrelated migrations to that shared
  database, and `prisma migrate dev` would have needed a full schema reset to proceed, destroying
  that Agent's data. Generated instead against a disposable database seeded from `prisma migrate
  deploy` against the current migration history, so the diff `prisma migrate dev` computes is
  exactly this record's own schema change.

## Consequences

- `apps/web`: `FileStorage` gains `head`/`presignPut`; `OssFileStorage` implements both,
  `LocalFileStorage` implements only `head`; `attachmentCapabilities` takes the storage port (and
  an optional `env`); a new `attachment_upload_sessions` table and Prisma model; a new
  `attachment-upload-session.server.ts` with the create/complete/cancel/get state machine and
  `AttachmentUploadSessionError`; four new routes under
  `routes/api/agent/v1/attachment-upload-sessions/`.
- `packages/coforge-sdk`: `agentApiRoutes.{local,cloud}.attachmentUploadSessions`; new
  `AgentAttachmentUploadSession*` types; `attachments.uploadSessions` on `AgentApiClient`/
  `RawAgentApiClient`.
- `packages/daemon`: `agent-proxy.ts` forwards two more route shapes (a fixed JSON POST, and a
  `/:uploadId[/complete]` JSON prefix); `runtime.ts` and `daemon-connection.ts` gain the four
  matching methods; `index.ts`'s runtime wiring gains them.
- `packages/coforge`: `local-client.ts`'s `callAttachmentUpload` gains the direct-upload decision
  and client flow; no change to `index.ts`'s command parsing, `attachment-upload.ts`'s local
  validation, or the CLI's text/JSON output shape.
- No wire-format break: every new field, route, and type is additive; the existing multipart
  upload path is untouched and still the only path when direct upload is unavailable or the file
  is below the threshold.
- Existing test contract changes (all covered by updated assertions, not weakened ones): the one
  `attachmentCapabilities()` unit test now passes a storage fake and asserts the new
  threshold-reporting behavior; three existing `FileStorage` test fakes
  (`attachments.test.ts`, `file-storage.test.ts`, `project-images.integration.ts`) gained a `head`
  implementation to keep satisfying the now-larger interface.

## Validation and rollback

Validation is `bun run check`, `bun run test`, and `bun run build` at the repository root, plus
this change's new tests: `apps/web/test/file-storage.test.ts` (`LocalFileStorage.head`,
`OssFileStorage.head`/`presignPut` including the real V4-signed round trip and the `409` conflict
against the fake-OSS fixture), `apps/web/test/attachments.test.ts` (updated capabilities test),
`apps/web/test/attachment-upload-session.test.ts` (every error code and the idempotency/replay
rules, with fakes), `apps/web/test/attachment-upload-session-route.test.ts` (the `create` route's
validation and error mapping), `apps/web/test/attachment-upload-session.integration.ts` (the
session table's own constraints and cascades against a real Postgres, requiring
`ATTACHMENT_UPLOAD_SESSION_TEST_DATABASE_URL`), `packages/daemon/test/agent-proxy.test.ts`,
`daemon-connection.test.ts`, and `daemon-runtime.test.ts` (the four new forwarded routes,
authorization, and header preservation).

Rollback is reverting the CR before merge (the migration only adds a new table with no data
written elsewhere yet, so a post-merge rollback needs a follow-up migration dropping
`attachment_upload_sessions`, safe as long as this feature has not already been used in
production).
