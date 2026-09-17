# ADR 0023: Agent attachment upload

Status: accepted
Date: 2026-09-17

## Context

Raft Computer 1.0.32 supports `raft attachment upload`: an Agent can upload a local file and get
back an attachment id to pass to a subsequent message send. CoForge already has the reverse half
of this feature — an Agent can download an attachment with `coforge attachment view --id <id>
--output <path>` (`apps/web/src/routes/api/agent/v1/attachments/$attachmentId.ts`, forwarded
through the daemon-local proxy's GET prefix in `packages/daemon/src/agent-proxy.ts`) — but no
Agent-facing upload path exists. Today `Attachment.uploaderId` is a required FK to `User`
(`apps/web/prisma/schema.prisma`), `storeAttachment` (`apps/web/src/server/attachments/
attachment.server.ts`) only ever writes it from a browser-authenticated User, and
`readAuthorizedAttachment` requires `messageId` to already be set before anyone may download an
attachment's bytes — correct for a browser upload, which always names its target message's
conversation and is downloaded only after being sent, but wrong for an Agent, which must be able
to inspect its own upload before deciding whether (or how) to send it, and has no message to
attach to until it does.

The daemon-local proxy (`agent-proxy.ts`) is a single `Bun.serve` handler that either forwards
one whitelisted JSON POST route per resource, or (for attachment download only) forwards any GET
under a path prefix as an opaque id to the identical cloud URL. It has no existing multipart
forwarding path, and every non-GET, non-whitelisted request is currently rejected as `415
unsupported media type` before the JSON body is even read.

`sending message send --attachment-id <id>` (the read half of "upload, then send") is being built
on the sibling branch `feat/message-send-flags` and is explicitly out of scope here: this record
does not touch the send route, its policy, or `message send` argument parsing.

## Decision

1. **Optional uploader, either a User or an Agent, never both.** `Attachment.uploaderId` becomes
   `String?` and a new `uploaderAgentId String?` (FK to `Agent`, `onDelete: Cascade`, indexed) is
   added, with the matching `attachments Attachment[]` back-relation on `Agent`. Prisma 7.10 (this
   repo's pinned version, `previewFeatures = ["fullTextSearchPostgres"]`) has no declarative
   `@@check` constraint syntax that avoids raw SQL in the generated migration, and the brief for
   this change explicitly forbids hand-editing a generated migration; the invariant "exactly one of
   `uploaderId` / `uploaderAgentId` is set" is therefore enforced only in application code —
   `storeAttachment` always sets `uploaderId` (and leaves `uploaderAgentId` unset), the new
   `storeAgentAttachment` always sets `uploaderAgentId: <agentId>` and `uploaderId: null` — not by
   a database constraint. Every existing reader of `uploaderId` (`storeAttachment`,
   `PublicChannels.send`'s attachment-ownership check, `PrismaDirectConversationRepository
   .sendMessage`'s equivalent check, and `task-board.server.ts`'s Task-attachment check) already
   filters by an equality match against a specific User id, so a `null` value on an Agent-uploaded
   row simply never matches those filters; none needed a code change beyond the type becoming
   optional.
2. **A new Agent HTTP route, mirroring the shape of the existing ones.**
   `POST /api/agent/v1/attachments` (`apps/web/src/routes/api/agent/v1/attachments/index.ts`, an
   `index.ts` file inside the existing `attachments/` route folder, resolving to the folder's own
   bare path alongside the existing `$attachmentId.ts` and `capabilities.ts` siblings) accepts a
   multipart `file` (required), `target` (required, the same `#channel`/`@user` grammar as
   `message send`, with any `:root` thread suffix stripped before resolution — the attachment
   belongs to the conversation, not a message, so upload never depends on a thread anchor already
   existing), and an optional `mimeType` override. It resolves `target` through
   `PrismaDirectConversationRepository`'s `resolveAgentTarget`, made `public` rather than
   duplicated (it already implements exactly this grammar for `message search`/`read`/`send`) and
   exposed on the `DirectConversationRepository` interface for the same reason every other
   Prisma-repository method is: so a caller can inject a fake in a unit test. The route's errors
   are the Agent API's `{ error: string }` convention (400 malformed input, 403 not a member or an
   unknown target, 413 too large), not the browser route's `{ code, errorId }` convention — this
   route is under `/api/agent/v1`, so it follows every other route there.
3. **The daemon-local proxy forwards one more shape: a POST whose body it never parses as JSON.**
   `agent-proxy.ts` special-cases the attachment-upload collection path before its existing
   `content-type !== "application/json" → 415` gate, enforces a body cap of `ATTACHMENT_MAX_BYTES
   + 64 KiB` by trusting `content-length` (rejecting with 413 when the header is missing,
   malformed, or over the cap — a missing header cannot be trusted for a streamed body, so it is
   treated the same as over-cap rather than read past), and forwards the request essentially as-is
   to a new `runtime.agentAttachmentUpload(context, request, agentApiKey)`, which mirrors the
   existing `agentAttachment` (download) method: authorize the local context, then delegate to the
   transport. `DaemonConnection.agentAttachmentUpload` buffers the incoming request to a `Blob`
   (`await request.blob()`) rather than streaming it to the cloud `fetch` call — streaming would
   need `duplex: "half"` on Bun's `fetch`, and the proxy's own cap already bounds the buffer to
   just over 10 MiB, cheap enough to hold in memory once rather than plumb a streaming body through
   an extra hop. The forwarded request keeps the original `content-type` header (and therefore its
   multipart boundary) unchanged; only the Agent-scoped `authorization`/`x-coforge-agent-api-key`
   headers are added, exactly as the existing JSON routes already do.
4. **The SDK route contract and CLI/client types grow in place.** `agentApiRoutes` gains
   `local.attachments.upload` and `cloud.attachments.upload` (both `{ method: "POST", path:
   "/api/agent/v1/attachments" }`, alongside the existing `collectionPath` on the cloud side), and
   `AgentApiClient`/`RawAgentApiClient` gain a structurally symmetric `attachments.upload(form:
   FormData): Promise<AgentAttachmentUploadResponse>` next to the existing `download`. This client
   is a documented but not fully wired transport-agnostic contract (`download` itself is not
   invoked through it in production today — the CLI and daemon both talk to the local proxy or the
   cloud route directly); the addition keeps that contract's shape complete rather than adding a
   second, asymmetric surface later.
5. **`coforge attachment upload --path <file> (--target <target>|--channel <target>) [--mime-type
   <type>] [--json]`, aligned with Raft 1.0.32's own command byte-for-byte where it applies.**
   `--channel` is Raft's legacy alias for `--target`; giving both is a usage error even when they
   agree (simpler than Raft's "must match" check, since the alias is transitional here too).
   Local, pre-request validation (`packages/coforge/src/attachment-upload.ts`, unit-tested) runs
   in Raft's exact order — `--path` presence, existence, regular-file, non-empty (all `CliError`
   code `INVALID_ARG`), then target presence (`MISSING_CHANNEL`, Raft's code, with a message
   adapted to this system's target grammar: `#name`/`@user`/thread target instead of Raft's
   `dm:@peer`), then `--mime-type` well-formedness (`INVALID_ARG`) — before any request is issued.
   An explicit `--mime-type` wins; otherwise the type is inferred from the file extension for
   `.jpg .jpeg .png .gif .webp .pdf .txt .md .json .csv`, defaulting to `application/octet-stream`.
   `local-client.ts`'s `upload()` then `GET`s `/api/agent/v1/attachments/capabilities` through the
   *existing* GET-prefix forwarding — the attachment-download forwarding in `agent-proxy.ts`
   treats any path segment after the attachment route prefix as an opaque attachment id and
   reaches the identical cloud URL unchanged, and `capabilities` is itself a literal cloud
   sub-route registered ahead of `$attachmentId`, so this already-shaped request reaches it with
   no daemon change; a `local-client.test.ts` case pins this behavior, and both call sites carry a
   comment pointing at each other. A 404 from that route (matching Raft's own
   `capabilityResponse.status === 404` branch) means "no capability endpoint": the CLI skips its
   client-side size check entirely and lets the server enforce its own limit on the real upload,
   rather than substituting a hardcoded default the way Raft does — this repo's `ATTACHMENT_MAX_BYTES`
   is already the server's one source of truth, so a second client-side copy of it would drift.
   Any other non-2xx capabilities response is `CliError` code `UPLOAD_CAPABILITY_FAILED`, before
   ever reading the file into memory. When a limit is advertised and `size > maxBytes`, the CLI
   fails locally with `CliError` code `ATTACHMENT_TOO_LARGE` before ever POSTing the file. A
   non-2xx upload response becomes `CliError` code `UPLOAD_FAILED` (or `SERVER_5XX` for ≥ 500),
   reading the upstream `{ error }` text — the same shape whether the failure came from the web
   route's own JSON body or from the daemon proxy's classified failure envelope, since both carry a
   top-level `error` field. On success the CLI prints Raft's exact `formatAttachmentUploaded` shape
   (`raft` swapped for `coforge`):
   ```
   File uploaded: <fileName> (<sizeKB, one decimal>KB)
   Attachment ID: <id>

   Use this ID with coforge message send --attachment-id <id> to include it in a message.
   ```
   `--json` prints the raw response object instead. `coforge attachment view` additionally
   accepts a positional id (`coforge attachment view <id> --output <path>`), matching Raft,
   alongside the existing `--id <id>` form.
   A `local-client.test.ts` case confirms, against a real `Bun.serve` round trip (not a mocked
   `fetch`), that the CLI's multipart `FormData` upload body carries a `content-length` header:
   Bun's `fetch` computes it up front for a `FormData` body the same way it does for a `Blob` or
   string body, so the daemon-local proxy's 413-on-missing-`content-length` guard (`agent-proxy.ts`)
   never fires for this CLI's own requests.
6. **The uploading Agent may always read back its own not-yet-sent upload.**
   `readAuthorizedAttachment` keeps requiring `messageId` to be set for every other reader (an
   Agent that is merely a member of the same conversation still cannot see an attachment nobody
   has sent yet), but bypasses that requirement when `attachment.uploaderAgentId === agentId`: the
   Agent that just uploaded a file needs to be able to inspect it (e.g. re-download to confirm
   what it sent, or hand the id to a tool) before any message references it.
7. **Direct/presigned upload stays deferred.** `attachmentCapabilities().directUploadEnabled`
   remains `false`; this change adds a proxied multipart upload only, matching what `message send
   --attachment-id` (the sibling branch) needs, and does not touch `attachment comments` or any
   presigned-URL flow.

## Rejected alternatives

- **A database check constraint for "exactly one uploader."** Rejected: Prisma 7.10's schema
  language has no declarative check-constraint syntax without dropping to raw SQL inside the
  generated migration, and this change's constraints (documented above) require every migration to
  be committed exactly as Prisma generates it. The invariant is cheap to hold in the two narrow
  write paths (`storeAttachment`, `storeAgentAttachment`) instead.
- **A separate Agent-only attachments table.** Rejected: it would duplicate `objectKey`,
  `fileName`, `contentType`, `sizeBytes`, and the storage lifecycle for no behavioral difference,
  and would force every downstream reader (`attachmentView`, the browser/Agent download routes,
  `PublicChannels`) to branch on which table a given id came from.
- **Streaming the multipart body through the daemon instead of buffering.** Rejected for now:
  Bun's `fetch` needs `duplex: "half"` to stream a `ReadableStream` request body, and the proxy's
  own size cap already bounds the buffer to a little over 10 MiB — cheap to hold in memory once.
  If a future change raises `ATTACHMENT_MAX_BYTES` meaningfully, streaming should be revisited.
- **Presigned direct upload in this change.** Rejected: out of scope per the brief; the `Not in
  scope` list explicitly defers it, and `directUploadEnabled` already exists as capability
  advertising for exactly that future decision.

## Consequences

- `apps/web`: `Attachment.uploaderId` is optional; `uploaderAgentId` is new. A new route
  (`routes/api/agent/v1/attachments/index.ts`), a new `storeAgentAttachment`, and a small
  behavioral change to `readAuthorizedAttachment` (the uploading Agent's self-download exception).
  `PrismaDirectConversationRepository#resolveAgentTarget` is now `public` and part of
  `DirectConversationRepository`.
- `packages/coforge-sdk`: `agentApiRoutes.{local,cloud}.attachments.upload`; a new
  `AgentAttachmentUploadResponse` type; `attachments.upload` on `AgentApiClient`/
  `RawAgentApiClient`.
- `packages/daemon`: `agent-proxy.ts` forwards one more request shape (POST, multipart, size
  capped by `content-length`); `runtime.ts` gains `agentAttachmentUpload`; `daemon-connection.ts`
  gains the matching transport method, buffering to a `Blob` and forwarding the original
  `content-type`; `index.ts`'s runtime wiring and `DaemonConnectionClient` gain the method.
- `packages/coforge`: a new `attachment-upload.ts` module (MIME inference, local validation); a
  new `attachment upload` CLI command; `attachment view` also accepts a positional id;
  `README.md` and `agent-instructions.ts` document the new command.
- No wire-format break: every new field (`uploaderAgentId`, the new routes, the new response type)
  is additive.
- The generated migration also runs `ALTER TABLE "weekly_report_assistants" ALTER COLUMN "id"
  DROP DEFAULT`, unrelated to this change's own schema edits: it is real, pre-existing drift.
  The `20260916100000_weekly_report_assistant` migration added a Postgres-level `DEFAULT
  gen_random_uuid()` that `WeeklyReportAssistant.id`'s `@default(uuid())` never asked for —
  Prisma's `uuid()` default is generated client-side, not at the database level — and `prisma
  migrate dev` correctly detects and corrects that mismatch the next time any migration touches
  the schema. It is kept as generated, per this ADR's own "commit the generated migration as
  generated, do not hand-trim" rule.

## Validation and rollback

Validation is `bun run check`, `bun run test`, and `bun run build` at the repository root (each
workspace's own check/test/build ran clean during implementation: `packages/coforge-sdk`,
`packages/daemon`, `apps/web`, `packages/coforge`), plus the new unit tests this change adds:
`apps/web/test/attachments.test.ts` (uploader-agnostic `storeAgentAttachment`, the self-download
exception, and that a different Agent still cannot read an unlinked upload) and
`apps/web/test/agent-attachment-upload.test.ts` (the new route's validation and error-status
mapping); `packages/daemon/test/agent-proxy.test.ts` and `daemon-connection.test.ts` (multipart
forwarding, the size cap, and header preservation); `packages/coforge/test/attachment-upload.test.ts`,
`cli.test.ts`, and `local-client.test.ts` (MIME inference, local preconditions, the capabilities
GET reuse, and error-code mapping).

Rollback is reverting the CR before merge (the migration adds a nullable column and a new FK; a
post-merge rollback needs a follow-up migration dropping `uploaderAgentId`, safe as long as no row
has been written with it non-null, which is true unless this feature has already been used in
production).
