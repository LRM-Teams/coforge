# ADR 0029: Multiple attachments per message

Status: accepted
Date: 2026-09-17

## Context

CoForge modeled at most one attachment per `Message` everywhere: `Attachment.messageId` was a
`@unique` foreign key, `Message.attachment` was an optional 1:1 relation, and every send path
(human channel, human direct message, Agent direct message/channel, Task creation) took a single
`attachmentId`. The Agent-facing wire contract mirrored this: `AgentMessagesSendRequest.attachmentId?:
string`, `AgentMessage.attachment?: {...}`, and the daemon-local proto's `LocalAgentMessageRequest
.attachment_id` / `AgentMessageRecord.attachment`.

Raft Computer 1.0.32 is prior art for the target shape: its message envelope carries `attachments:
array(agentApiAttachmentEnvelopeSchema)` and `raft message send` takes a repeatable `--attachment-id`.
Per `docs/agents/reference-cli-research.md` and repository policy, this record uses that product's
observable behaviour only as the specification for what "aligned" means, and copies none of its code,
identifiers, or wording.

Two other ADRs already touch attachments and are relevant precedent, not superseded wholesale:

- **ADR 0022** established `--attachment-id`'s single-id validation (same workspace, same
  conversation, unlinked) and named an explicit "Known limitation": because Agents had no upload
  route, `sendAgentMessage` never checked attachment ownership by uploader identity — any human's
  unlinked upload in the conversation would pass. It named `coforge attachment upload` as the
  follow-up that would need to revisit this.
- **ADR 0023** shipped that follow-up: Agents can now upload their own attachments
  (`Attachment.uploaderAgentId`, `POST /api/agent/v1/attachments`). It left closing ADR 0022's
  ownership gap to whichever change actually needed it, rather than doing so speculatively.

This record is that change, and closes the gap: this is the natural point to require
`uploaderAgentId === agentId` on every attachment an Agent send links, since a multi-attachment
send validates each id in a loop already.

ADR numbers 0025 through 0028 are already assigned: 0025 (channel membership and Agent creation
authority) and 0026 (projects without a default discussion group) are merged on `origin/main`;
0027 (Agent action cards) merged concurrently while this record was in progress; 0028 belongs to
the concurrent presigned direct-upload branch. This record is 0029.

## Decision

**1. Schema: `Message.attachments Attachment[]`, ordered by a new `Attachment.position` column.**
`Attachment.messageId` drops its `@unique` constraint (plain `String? @db.Uuid`); a new
`position Int @default(0)` column is added, indexed together as `@@index([messageId, position])`.
The column name (`Attachment.messageId`, still the same FK) is unchanged, minimizing the migration's
surface. One generated migration, `20260917024406_message_attachments_many`, committed exactly as
Prisma generated it (`prisma migrate dev` against a disposable, freshly-migrated scratch database —
see "Rejected alternatives" for why not the shared local dev database): it drops the old unique
index, adds the column, and adds the new index. No unrelated drift.

**2. Wire: `attachmentIds`/`attachments` replace `attachmentId`/`attachment` everywhere, as a
breaking change.** `AgentMessagesSendRequest.attachmentIds?: string[]` (max 10, unique, each a
UUID — enforced by the cloud send route, `POST /api/agent/v1/messages`, before any repository call)
replaces `attachmentId?: string`. `AgentMessage.attachments: {id, fileName, contentType,
sizeBytes}[]` — **always present, possibly empty**, ordered to match send/upload order — replaces
`attachment?: {...}`. The same replacement happens on every layer beneath: the daemon-to-Web wire
type `AgentMessageRequest.attachmentIds?: string[]` (`packages/coforge-sdk/src/internal/index.ts`);
the daemon-local proto (`local_rpc.proto`) — `LocalAgentMessageRequest.attachment_id` (field 19)
becomes `repeated string attachment_ids = 19`, and `AgentMessageRecord.attachment` (field 7)
becomes `repeated LocalAttachmentMetadata attachments = 7`; the daemon's draft store and in-memory
inbox state machine persist `attachmentIds?: readonly string[]` instead of a single id.

This is a breaking wire change with no compatibility window: protocol major stays 1, matching ADR
0018's precedent for route-shape changes (the CLI, daemon, and server in this monorepo ship
together; there is no independently-versioned external consumer of the local proto or the cloud
Agent API to protect). Every new/changed field is otherwise additive in shape (an array instead of
a scalar), so an old build talking to a new one, or vice versa, would simply see zero or one
attachment rather than failing to decode — this record does not rely on that property for rollout,
since both sides ship in the same change, but it is a useful safety margin.

**3. CLI: `--attachment-id` becomes repeatable, uncapped client-side, deduplicated.** Raft's own
`message send` schema has no client-side count limit on `attachmentIds`, so this CLI matches: no
cap is enforced before the request is issued, and duplicate values collapse to one occurrence
(order-preserving) rather than being rejected as a usage error. The server remains the one place
that enforces the count bound (10) — see point 2 — returning a typed 400 beyond it.
`formatMessageLine` (`packages/coforge/src/message-format.ts`) renders every attachment on a
message, mirroring Raft's multi-attachment line shape:

```
[<N> attachment(s): <fileName> (id:<id>), <fileName> (id:<id>) — use `coforge attachment view --id <attachmentId> --output <path>` to download]
```

(singular "attachment" for `N = 1`; the suffix is empty for `N = 0`.) Every attachment id in this
line is printed in full — never an 8-character short id — since `attachment view` needs the exact
UUID, matching Raft. `--json` output already carried the raw response object; because
`AgentMessage.attachments` is now always present, `--json` output carries the full `attachments`
array on every message with no CLI-side change beyond the type update.

**4. Server: every send path validates every id inside its existing transaction, then links
positions.** Because the FK relationship moved from a 1:1 (which supported a nested
`attachment: { connect: { id } }` write under `Message.create`) to a 1:many ordered by
`position`, the write mechanics for every send path changed to: validate every attachment id
*before* creating the message (same `workspaceId`, same resolved `conversationId`, `messageId:
null`, plus — for an Agent send — `uploaderAgentId === agentId`, closing ADR 0022's gap per the
Context above); create the `Message` with no nested attachment write; then, in the same
transaction, `update` each validated `Attachment` row's `messageId`/`position` to the new
message's id and its 0-based index in the input array. Any validation failure throws the same
error class each call site already threw for a single bad id (`AgentSendRejectedError(403, ...)`
for Agent sends per ADR 0022; `AppError("ACCESS_DENIED")` for human channel/DM sends) — no new
error type. Human send paths (`PublicChannels.send`, `PrismaDirectConversationRepository
.sendMessage`, `SendDirectMessage.execute`) accept `attachmentIds: string[]` the same way. Task
creation (`TaskBoard`) deliberately keeps a single `attachmentId` — multi-attachment Task creation
is out of this record's scope — but its write mechanics needed the same fix, since the old nested
connect no longer expresses per-row `position` on the to-many relation.

**5. Browser: the composer uploads multiple files sequentially; message rendering shows every
attachment.** `message-composer.tsx` moves from one `PendingAttachment` to a list, uploading each
through the existing `/api/attachments` route one at a time (never in parallel, matching the CLI's
own upload-then-send sequencing), each with its own remove button using the existing Untitled UI
components already used for the single-attachment case — no new components, no restyle.
`message-row.tsx` renders every attachment on a message by mapping over the array and reusing the
existing single-attachment presentation per item. The zod message-send schemas
(`conversation.schemas.ts`'s shared `attachmentIdsSchema`, reused by `channels.functions.ts`) fully
migrate from `attachmentId: z.uuid().optional()` to a bounded (`max(10)`), duplicate-rejecting
`attachmentIds` array — the singular field is removed outright rather than kept alongside the
array, since the browser bundle and the server it calls deploy together in this one monorepo and
there is no external client to protect.

**6. Delivery to Agents: every place that copied a message's `attachment` into an Agent-facing
record now copies `attachments`.** This includes `AgentMessageDelivery`-adjacent read paths, the
events drain, recovery/pending-delivery context, and search/resolve results. Making
`AgentMessage.attachments`/`AgentMessageRecord.attachments` a required (never-optional) array
surfaced one latent gap at compile time: `PrismaDirectConversationRepository`'s `searchMessages`
and its thread-anchor resolve path had Prisma `include` blocks that never selected attachment data
at all, so Agent search results and anchor-resolve results silently omitted attachment metadata
even in the single-attachment world. Both now include attachments like every other Agent-facing
read.

## Rejected alternatives

- **A database check constraint capping attachments per message at 10.** Rejected, matching ADR
  0023's precedent for "exactly one uploader": Prisma 7.10 has no declarative check-constraint
  syntax without dropping to raw SQL in the generated migration, and this repository's migrations
  must be committed exactly as generated. The 10-attachment bound is enforced in the cloud send
  route (shape validation) before any repository call, and is cheap to hold there.
- **A join table (`MessageAttachment`) instead of an ordering column on `Attachment`.** Rejected:
  `Attachment` already belongs to exactly one conversation and, once sent, exactly one message;
  a join table would only be needed if an attachment could belong to multiple messages, which is
  not a requirement here and would reopen questions this schema already answers cleanly (upload
  ownership, storage lifecycle, per-attachment authorization).
- **Generating the migration against the shared local dev Postgres (127.0.0.1:5433).** Rejected:
  that database is shared across concurrent worktrees on this machine (a sibling branch's
  in-progress schema changes were already applied to it, causing drift unrelated to this change).
  The migration was instead generated against a disposable, freshly-created scratch database
  seeded only with this branch's own migration history, then dropped — leaving the shared
  database and every other concurrent worktree's data untouched.
- **Keeping `attachmentId` alongside the new `attachmentIds` in the browser's zod schemas "for
  compatibility."** Rejected: this is one monorepo where the browser bundle and the server it
  calls deploy together; there is no independently-released or externally-versioned client to
  protect, unlike the Agent CLI/daemon (which do warrant the additive-field caution described in
  point 2 above, though this record does not rely on it since everything ships together anyway).
- **Leaving `sendAgentMessage`'s uploader check as ADR 0022 left it (any unlinked attachment in
  the conversation).** Rejected now that this record already loops over every attachment id for
  validation: adding `uploaderAgentId === agentId` to that same loop is a small, targeted fix to a
  gap both ADR 0022 and ADR 0023 explicitly flagged rather than silently closed, and multiple
  attachments per Agent send make an unintended cross-Agent attachment reuse more likely to matter
  in practice, not less.

## Consequences

- `packages/coforge-sdk`: `proto/coforge/rpc/v1/local_rpc.proto` — `LocalAgentMessageRequest
  .attachment_ids` (repeated string, field 19), `AgentMessageRecord.attachments` (repeated
  `LocalAttachmentMetadata`, field 7); regenerated `local_rpc_pb.ts` (gitignored, regenerated by
  `bun run generate`/`check`/`build`). `src/internal/local-daemon.ts`: `LocalAttachment` is now a
  named exported type; `AgentMessageRecord.attachments: LocalAttachment[]` (always present);
  `LocalAgentMessageRequest.attachmentIds?: string[]`; new `encodeLocalAttachments`/
  `decodeLocalAttachments` helpers replace the old singular `decodeLocalAttachment`.
  `src/internal/task-codec.ts` (`TaskResponse.heldMessages`, which reuses `AgentMessageRecord`)
  updated to match. `src/internal/index.ts`: the daemon-to-Web `AgentMessageRequest.attachmentIds?:
  string[]`. `src/agent/messages.ts`: `AgentMessagesSendRequest.attachmentIds?: string[]`;
  `AgentMessage.attachments` (always present array).
- `packages/daemon`: `agent-proxy.ts` validates `payload.attachmentIds` as an array of UUIDs (no
  count cap at this layer either — see point 3); `connection/daemon-connection.ts` forwards
  `attachmentIds` in the send HTTP body; `daemon-runtime/agent-inbox-state-machine.ts` and
  `persistence/agent-message-draft-store.ts` persist `attachmentIds?: readonly string[]` on a
  draft (an older on-disk draft with the singular field simply has no attachments once loaded —
  acceptable degradation, not a hard migration); `daemon-runtime/runtime.ts`'s `#sendAgentMessage`
  forwards the array end to end, including on a `--send-draft` resend.
- `packages/coforge`: `index.ts` parses repeatable `--attachment-id` (dedup, no cap);
  `src/local-client.ts` forwards `attachmentIds`; `src/message-format.ts`'s `formatMessageLine`
  renders every attachment. `README.md` and `packages/daemon/src/code-agent/agent-instructions.ts`
  updated (the Agent-visible read/send contract changed).
- `apps/web`: `prisma/schema.prisma` (`Message.attachments`, `Attachment.position`, dropped unique
  constraint) plus the generated migration described above. Every send path
  (`PrismaDirectConversationRepository.sendMessage`/`sendAgentMessage`, `PublicChannels.send`,
  `SendDirectMessage.execute`, `TaskBoard`'s message-creating write) and every Agent-facing read
  path (`readMessages`, `searchMessages`, resolve, recovery/pending-delivery context) updated per
  points 4 and 6. `routes/api/agent/v1/messages.ts` validates `attachmentIds` shape (400 on
  violation). `conversation.schemas.ts`, `channels.functions.ts`, `conversations.functions.ts`
  migrate to `attachmentIds`. `message-composer.tsx`/`message-row.tsx`/`direct-conversation.tsx`/
  `channel-conversation.tsx` per point 5. `TaskCommand.attachmentId` and its CLI/browser
  `onCreateTask` signature are unchanged (Task creation stays single-attachment).
  `attachment.server.ts`/`attachment-view.server.ts`/`attachment-response.server.ts` need no
  change: every reader there already keys on one attachment id regardless of how many are linked
  to its message.

## Validation and rollback

Validation is `bun run check`, `bun run test`, and `bun run build` from the repository root,
covering: `packages/coforge-sdk`'s local-daemon/task-codec encode-decode round-trip tests and
`agent/messages.test.ts`'s multi-attachment fixture; `packages/daemon`'s `agent-proxy.test.ts`,
`daemon-connection.test.ts`, `daemon-runtime.test.ts` (repeated-`attachmentIds` forwarding across a
held-then-resent send, including a `--send-draft` resend), and `agent-message-draft-store.test.ts`;
`packages/coforge`'s `cli.test.ts` (repeatable/deduplicated `--attachment-id` parsing) and
`message-format.test.ts` (one- and two-attachment line rendering); `apps/web`'s
`direct-conversation-repository.test.ts` (two new unit tests: send-order-to-`position` mapping for
both `sendAgentMessage` and `sendMessage`, and the `uploaderAgentId` rejection), `direct-message
.test.ts`, `agent-messages-service.test.ts`, `agent-messages-send-http.test.ts` (route-level shape
validation: too many ids, a duplicate, a non-UUID entry), and `conversation-history.test.ts`. The
`*.integration.ts`/`*.e2e.ts` suites needing a live Postgres/Redis were updated to compile and
exercise the new shapes but were not executed as part of this record's own validation pass (they
require per-suite `*_TEST_DATABASE_URL`/`*_TEST_REDIS_URL` environment variables and are excluded
from the default `bun test` glob); `apps/web`'s default `bun run test` selection ran clean.

Rollback is reverting this change's commits before merge. Post-merge, rolling back is a follow-up
migration dropping `Attachment.position` and restoring the unique constraint on
`Attachment.messageId` — safe only if no message has been linked to more than one attachment since
this record shipped, since the unique constraint cannot be restored otherwise without first
choosing which attachment "wins" per message.
