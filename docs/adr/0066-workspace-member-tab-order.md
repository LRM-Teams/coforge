# ADR 0066: Members reorder panel tabs, saved per Workspace member

Status: accepted
Date: 2026-09-23

## Context

The conversation header (Chat / Tasks / Files) and the Agent profile panel (Profile /
Reminders / Activity / Workspace) had fixed tab orders. Frank asked for both strips to be
reorderable by drag and for the order to be remembered.

The reference app (Raft web, app.raft.build, bundle `index-Bu_pi40n.js`) stores
`channelPanelTabOrder` and `agentPanelTabOrder` server-side per user and server in
`GET/PATCH /servers/{id}/sidebar-order`. It arranges saved ids first and appends unsaved tabs in
default order, opens the first tab when the URL names none, updates optimistically and reverts
silently when a save fails, and drags with dnd-kit Sortable.

## Decision

- A new table `workspace_member_preferences`, one row per Workspace membership (composite
  primary key `workspaceId, userId`, foreign key to `workspace_memberships` with
  `ON DELETE CASCADE`). It holds a member's own settings inside one Workspace; account-level
  settings stay in `user_preferences` (ADR 0064).
- Columns `conversationTabOrder` and `agentProfileTabOrder` are `TEXT[]` defaulting to an empty
  array: Prisma scalar lists cannot be optional, so an empty list — not NULL — means the default
  order. A `CHECK (<col> <@ ARRAY[...])` keeps each list to its panel's tab ids; the application
  also rejects duplicates. Adding a tab widens the CHECK in a migration; saved lists need no
  rewrite because unsaved tabs are appended in default order.
- `WorkspaceMemberPreferences` (`server/db/repositories/workspace-member-preferences.repositories.server.ts`)
  is the only reader and writer. `features/panel-tabs/` owns the arrangement rules
  (`panel-tab-order.ts`), the Server Functions and the layout-level provider.
- The first tab of the member's order opens when the URL names no tab, and the chosen tab is
  then written into the URL (replace) so closing a thread or reordering does not move the page.
  Links to a message name `view=chat` where they are built (push notification targets, Reminder
  anchors, in-page message jumps), because the server rendering the page never sees the
  `#message-…` hash.
- Tabs the viewer cannot see (permission-gated Agent tabs) keep their saved slots when the
  viewer reorders the visible ones.
- Dragging uses dnd-kit Sortable (already the Task board's drag library) through
  `components/ui/reorderable-tab-strip.tsx`. Reordering is pointer and touch only.
- Saves share one TanStack Query mutation scope, so they run one at a time; a failed latest save returns the strip to the last confirmed
  order without a message, as in the reference app.

## Alternatives

- **Columns on `user_preferences`.** One order for every Workspace; the reference app keeps
  it per server.
- **Browser storage.** No schema change, but the order would not follow the member across
  devices.
- **React Aria `useDragAndDrop`.** Gives keyboard reordering, but only for collection
  components (ListBox/GridList), which would change the strips' button semantics; the reference
  app and the Task board use dnd-kit.

## Consequences and open points

- No keyboard reordering yet.
- A failed save is silent, which departs from `docs/design.md` §13 ("失败要给出原因和重试");
  kept to match the reference app, to be revisited if saves are seen failing.
- Rollback: drop the table in a reverse migration; the UI falls back to default order.
