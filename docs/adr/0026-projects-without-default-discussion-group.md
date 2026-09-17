# ADR 0026: Create projects without a default discussion group

Status: accepted
Date: 2026-09-17

## Context

`createProject` in `apps/web/src/features/projects/projects.functions.ts`
created every new `Project` together with a first `Conversation` in the same
Prisma write, using a nested `conversations: { create: { channelName:
data.slug, members: { create: { userId: context.user.id } } } } }`. This
behavior was recorded in `docs/architecture.md` ("创建 Project 时保留自动创建
首个讨论组的行为") as a decision Frank confirmed while the project detail page
was implemented.

Discussion groups are project-scoped `PublicChannel`s (not Message Threads),
and the product already has two independent, fully working entry points to
create one on demand: the "New discussion group" button on
`apps/web/src/features/projects/project-detail.tsx`, and the "Create channel"
dialog's project selector in
`apps/web/src/features/conversations/create-channel-dialog.tsx` (used from
`conversation-navigation.tsx`). Both call the same
`PublicChannels.create(workspaceId, userId, name, projectId)` seam, which
already validates the project belongs to the caller's Workspace. Nothing about
this seam depended on a first channel having been auto-created — the existing
integration test `apps/web/test/project-channels.integration.ts` creates its
"existing" channel with a direct `db.conversation.create` and its "created"
one through `PublicChannels.create`, never through `createProject`.

Auto-creating a discussion group on every project forces a channel name (the
project's slug) that the creator may not want as a channel identity, and it
means a project with, say, only a GitHub repository and no chat use yet still
carries an unused channel and membership row. `project-detail.tsx` already
renders a real empty state (`m.project_discussions_empty()`) when
`project.conversations.length === 0`, and `projects-content.tsx` already
renders `{count} discussion groups` correctly for zero, so removing the
auto-create requires no new empty-state UI — only removing the now-incorrect
architecture claim that one always exists.

## Decision

Remove the nested `conversations: { create: … }` write from `createProject`.
A newly created project starts with zero discussion groups; its `create`
Prisma call's `select` no longer needs to return `conversations` either,
since no caller reads that field from the create response (the directory and
detail pages both re-fetch through `listProjects`/`getProject`, which are
unchanged and continue to select `conversations`).

Discussion groups remain reachable only through
`PublicChannels.create(..., projectId)`, from the two existing UI entry
points. To make the first discussion group's identity less arbitrary once a
project exists, "New discussion group" now prefills (but does not force) the
channel-name field with the project's slug via a new, optional
`CreateChannelDialog` prop, `defaultName`; the chat-list "Create channel"
entry point continues to pass no default.

## Rejected alternatives

- **Keep auto-creating a discussion group but let the creator name it in the
  create-project dialog.** Rejected: this couples project creation to channel
  creation for no product reason, complicates `createProject`'s input and
  transaction, and still leaves a channel nobody asked for on projects created
  purely to track a repository.
- **Auto-create the channel only when no GitHub repository is attached.**
  Rejected: an unstated, surprising rule a user would have to learn by
  experiment; the product owner's direction was to make discussion-group
  creation an explicit, on-demand action in all cases.

## Consequences

- `apps/web/test/project-channels.integration.ts` and
  `apps/web/test/public-channel.integration.ts` no longer assume a project
  ships with a channel; both already exercised `PublicChannels.create` and
  `db.conversation.create` directly and needed no behavioral change, only
  confirmation via a fresh full-suite run.
- `docs/architecture.md`'s Project paragraph is corrected to state that
  project creation does not auto-create a discussion group, and links here.
- `apps/web/AGENTS.md`'s projects paragraph records the two remaining
  discussion-group creation entry points and the new slug-derivation helper
  (`apps/web/src/lib/slug.ts`) shared with Workspace creation.
- No schema or migration change: `Conversation.projectId` was already
  nullable with an ordinary index (not a one-to-one unique constraint), so
  removing the auto-create does not affect existing projects or discussions.
