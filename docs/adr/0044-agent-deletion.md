# ADR 0044: Deleting an Agent hides it and keeps its history

Status: accepted
Date: 2026-09-18

## Context

The Agent profile panel's ACTIONS section (`features/agents/panel/agent-profile-tab.tsx`)
offers Start/Stop and Restart/Reset/Full reset, but nothing removes an Agent. Users need to
delete an Agent they no longer want.

A hard delete is impossible for any Agent that has ever done anything. `Message.sender`,
`Task.creator`/`owner` and `ActionCard.preparedByAgent` all reference the Agent with
`onDelete: Restrict`, and deleting the `Agent` row cascades to its `ConversationMember` rows,
which those same messages depend on. This is the identical blocker ADR 0024/0031 hit for channel
membership, and they resolved it with a soft marker (`ConversationMember.leftAt`) rather than a
delete. CoForge also keeps canonical Message history as its recovery boundary (architecture.md),
so destroying an Agent's messages is not an option regardless.

### Raft comparison

Read from the shipped Raft Computer 1.0.32 client/daemon bundle per
`docs/agents/reference-cli-research.md`; no code was copied.

**VERIFIED:**

- `packages/shared/src/serverPermissions.ts` defines a `deleteAgents` capability. It sits with
  `createAgents`/`editAgents` in `ADMIN_SERVER_CAPABILITIES` and is absent from
  `MEMBER_SERVER_CAPABILITIES`, so deleting is owner/admin-only.
- The Agent profile contract (`agentApiProfileViewSchema`, `kind: "agent"`) carries a nullable
  `deletedAt`, and `formatAgentProfile` prints `- Deleted At: …` when present. The profile
  contract also exposes `deletedAt` on an Agent _creator_ (`agentApiProfileCreatorSchema`).
- Agent deletion therefore is a soft delete that preserves the identity, consistent with the
  `Restrict`-style history this product keeps elsewhere.

**INFERRED** (server source unavailable): the deleted Agent stops, disappears from directories,
and cannot be messaged or woken.

## Decision

1. **`Agent.deletedAt` (nullable) is the delete marker**, the same shape as
   `ConversationMember.leftAt`. `ACTIVE_AGENT_WHERE` (`server/agents/active-agent.server.ts`,
   `{ deletedAt: null }`) is the one predicate every live-view query applies, so "is this Agent
   live" is never inferred from row existence alone.
2. **A deleted Agent is inert cloud-side.** `AgentDeletion.delete()` runs under the Agent runtime
   lock and `PrismaAgentDeletionStore` performs one transaction that sets `deletedAt`, soft-leaves
   every channel membership (`leftAt`, which is what actually stops delivery and wake, since both
   read `ACTIVE_MEMBER_WHERE`), cancels scheduled Reminders, and revokes Agent API keys.
3. **History is preserved.** Messages, Tasks, Action cards, Thread reads and Activity are never
   touched. A deleted sender still renders, greyed with a `DELETED` badge, and no longer opens a
   profile.
4. **Authorization is Raft's `deleteAgents`**: `assertCanDeleteAgents` is Workspace owner/admin
   only — the same gate as `assertCanCreateAgents` — never Agent ownership alone. Deleting is
   confirmed by typing the Agent's username, and the server re-checks that name against the
   current row inside the delete call (the `ProjectSettings.delete` guard), so a concurrent
   rename cannot bypass confirmation.
5. **The delete is the durable intent; the runtime stop is best effort.** `deletedAt` is persisted
   before the Stop is published, so an offline Computer cannot block the operation the user asked
   for. `WorkspaceAgentRecovery` lists deleted Agents separately and, if the Daemon still reports
   one running, reconciles it with a Stop — it never starts a deleted Agent.
6. **The weekly-report assistant is not a delete target.** `Records` provisions it on demand by
   `(workspaceId, userId)`; deleting it would only recreate it and break the feature meanwhile.
   The store refuses it with `outcome: "protected"`, and the profile payload's `canDeleteAgent`
   is false for it.

## Rejected alternatives

- **Hard delete with `Restrict` removed or cascaded.** Destroys canonical Message/Task history and
  the message-recovery boundary, and contradicts how ADR 0024/0031 already model "this identity is
  gone from here".
- **An `AgentStatus`-style `deleted` value instead of a column.** Agent status is a volatile
  lease-derived display projection (`agent-display.server.ts`), explicitly not durable state; the
  delete intent must survive Redis loss and daemon restarts, exactly as `stoppedAt` (ADR 0038)
  does.
- **Reusing `stoppedAt` for deletion.** Stop is a resumable state a user can undo with Start;
  deletion is not, and the two must not be conflated — `recover` clears nothing on `stoppedAt`
  alone but must never start a deleted Agent.
- **Allowing the Agent's own owner to delete it as a plain member.** Raft's `deleteAgents` is
  admin-only, and CoForge already gates creation the same way.

## Consequences

- A deleted Agent's `name` stays reserved (`@@unique([workspaceId, name])` is unchanged and the
  row is not removed), so a new Agent cannot silently inherit an old Agent's `@handle` and
  history. Recreating the same name requires a different username.
- `AgentRepository.getById` deliberately returns a deleted Agent (control, session and deletion
  code must observe one to keep it inert); every caller serving a live view applies
  `ACTIVE_AGENT_WHERE` itself. `listInWorkspace`/`listForComputer`/`listOwnedInWorkspace` apply it
  internally.
- An Agent API key minted before deletion is revoked; the daemon's `agent:start` for a deleted
  Agent is refused because the Agent is absent from the launch authorization path.
- The Members directory, Chat DM list, `@`-mention targets, channel member pickers, Task
  assignment, reminders and the Agent profile lookup all stop returning the deleted Agent.
- No un-delete/restore surface is introduced. A mistaken delete is recovered by creating a new
  Agent; the deleted one keeps its history.

## Validation and rollback

- `apps/web/test/agent-deletion.test.ts` covers authorization (member denied, owner/admin allowed,
  admin deleting another owner's Agent), scope (`NOT_FOUND` for another Workspace or an unknown
  id), the no-Computer and failed-stop paths, idempotent re-delete, and the protected
  weekly-report assistant.
- `apps/web/test/agent-deletion.integration.test.ts` is the end-to-end check against real local
  PostgreSQL (`CHANNEL_TEST_DATABASE_URL`, skipped without it like the other integration suites).
  It drives the real `AgentDeletion` + `PrismaAgentDeletionStore` and then asserts through the
  other live-view seams: the Members directory and the by-name profile lookup both drop the Agent,
  `listInWorkspace` excludes it while `getById`/`listDeletedForComputer` still see it for
  recovery, the DM read path still returns the seeded message with `senderDeleted: true`, the
  unique `(workspaceId, name)` still rejects reuse, a plain member is denied, and a repeat delete
  neither moves `deletedAt` nor sends a second Stop. Two further cases cover Agent API key
  revocation plus Reminder cancellation, and the protected weekly-report assistant.
- `apps/web/test/workspace-members.test.ts`, `weekly-report-assistant-authorization.test.ts`,
  `agent-repository.test.ts`, `cloud-agent.test.ts` and `channel-message-view.test.ts` assert the
  live-view filters and the deleted-sender projection.
- **Fixed in passing**: `public-channel.integration.ts`'s "Workspace humans enrolled in general
  see one general channel" had two stale assertions left over from before PR #338 introduced
  embedded-UUID mention-token storage: they expected a stored body of `@bob please review this`
  where the product deliberately stores `<@human:<uuid>> please review this` (the server comment
  at `public-channels.server.ts` states the stored body keeps the token; the browser renders the
  handle from the `MessageMention` row). They had been failing on `origin/main` already —
  verified by rerunning them in a clean `origin/main` worktree. The assertions now assert the real
  contract (stored token plus the resolved mention row the viewer renders from), so this is
  correcting an invalid assumption, not weakening a valid test. The file went from 212 to 233
  passing assertions.
- Rollback is reverting the commit plus the additive `deletedAt` migration; nothing else depends
  on the column, and no data is destroyed by the change itself.
