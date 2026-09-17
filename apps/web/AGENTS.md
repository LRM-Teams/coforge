# Web application instructions

These instructions apply to `apps/web` and refine the repository-level
instructions for the TanStack Start Web/backend modular monolith.

## Product design

- Before designing or changing product UI, read and follow
  [the product design guidance](../../docs/design.md), including progressive
  disclosure, task-led hierarchy, and rendered verification.
- That document is the maintained source for interaction rules. For similar
  list/detail pages and empty states, apply sections 2.1–2.2 and 5.1, and run
  the applicable acceptance checks in section 6. State why a different user
  task requires an exception before implementing one. Do not duplicate these
  rules in another design document or treat existing pages as automatic
  exceptions; adapt the affected flow when changing it, without expanding into
  unrelated page redesigns.
- Reuse the existing UI primitives and the color ownership defined in
  [design tokens](../../docs/design-tokens.md). Do not apply marketing-page
  defaults from `design-taste-frontend` to the product workspace.
- Keep supplemental explanations behind accessible, on-demand help when
  appropriate; keep essential constraints, errors, and risks visible. Help
  must work for keyboard and touch users, not only on hover.

## TanStack Start boundaries

- `src/server.ts` is the TanStack Start runtime entry point. Keep it limited to
  request middleware and the Start server handler; do not put feature behavior
  there.
- Use a Server Function (`createServerFn`) for data and mutations called by
  the Web UI. Put the public function at the owning feature seam, for example
  `src/features/agents/agents.functions.ts`.
- Put database clients, repositories, authentication implementation, OSS,
  Centrifugo RPC handlers, and other server-only implementations under
  `src/server/`. Use `.server.ts` naming where a module must never enter the
  client bundle.
- Route loaders may call Server Functions, but must not access a database,
  filesystem, secret, or server-only SDK directly. Do not self-fetch a
  relative `/api/...` URL from an SSR loader.
- Validate Server Function inputs and enforce authorization on the server.
  Router `beforeLoad` guards improve navigation UX but are not a security
  boundary.
- Use a Server Route under `src/routes/api/` only when the raw HTTP contract is
  part of the product: webhooks, third-party REST clients, feeds, or file
  responses. Do not create an API route just to serve data to a TanStack Start
  page.

## PostgreSQL and Prisma

- Prisma is the Web/backend database standard. Use the repository's Prisma
  skills for CLI, Client API, database setup, and Prisma upgrades before
  changing database code.
- Keep `prisma/schema.prisma`, generated client usage, repositories, and
  migrations on the server side. UI routes and feature components must call a
  Server Function or server service instead of importing Prisma.
- Change the Prisma schema first, review the generated SQL migration, and
  commit migrations. Never use `prisma db push` or `prisma db reset` for shared
  environments, CI, staging, or production; never mutate schema on application
  startup.
- Keep `prisma`, `@prisma/client`, and the PostgreSQL driver adapter on the
  same supported major version, pinned by the workspace lockfile. Use the
  repository's Bun-compatible Prisma setup rather than adding an alternate
  database client.
- Use parameterized Prisma queries. Use `$queryRaw`/`$executeRaw` only for a
  reviewed PostgreSQL-specific requirement, and keep that SQL in a server-only
  repository or migration.
- Use PostgreSQL for database-semantic tests; do not silently substitute SQLite.
- Read the database URL and credentials from runtime environment/secret
  injection. Local development uses the project's Docker PostgreSQL; managed
  PostgreSQL changes must not leak provider-specific details into domain code.

## Route and page organization

- `features/projects/` owns the Projects directory, its loading state, and the
  creation dialog and detail dashboard (commits, discussion groups, repository
  files). `projects.functions.ts` is the authenticated
  list/create/detail seam. `/projects` owns the directory route; the existing
  `/projects/$projectSlug` owns project detail. AppShell exposes one Projects
  navigation item on desktop and mobile; project creation belongs on the page,
  not in either sidebar. `GitHubConnection` owns user-authorized repository
  overview reads; project functions enforce Workspace scope before invoking it.
  Discussion groups reuse `PublicChannels.create` and the existing channel route.
  Project creation no longer creates a first discussion group; discussion groups
  are created on demand through the project page's "New discussion group" button
  or the "Create channel" dialog's project selector, both through the same
  `PublicChannels.create(..., projectId)` seam. A project's discussion-group list
  starts empty, and `create-project-dialog.tsx` derives the project slug from the
  name (see `lib/slug.ts`), the same pattern `workspace-switcher.tsx` uses for
  Workspace creation.

  `server/projects/project-settings.server.ts` owns Workspace-member-authorized
  project settings and name-confirmed deletion. `projects.functions.ts` validates
  browser input; `project-settings.tsx` owns the standalone settings page at
  `/projects/$projectSlug/settings`, including image upload and deletion confirmation.
  `server/projects/project-images.server.ts` owns authorized image replacement/read
  through `FileStorage`; the GET icon route only serves authorized image bytes.
  Shared image validation lives in `server/files/image-upload.server.ts`.
  Repository changes require the caller's GitHub access. Deletion preserves
  discussion groups, memberships and messages by clearing their Project relation.

- Personal GitHub connections belong to `server/integrations/github-connection.server.ts`.
  `GitHubConnection` owns authorization attempts, encrypted user credentials,
  refresh serialization, installation/repository access, on-demand Agent owner
  user credentials and disconnect. GitHub connections do not create login identities
  or confer Workspace authority.
  `features/integrations/github.functions.ts` exposes authenticated browser
  operations; the raw OAuth callback is a thin route adapter. Settings owns
  the Integrations section, with its GitHub view in `features/integrations/`.

- `src/features/landing/` owns the single-page public homepage composition and its
  inline Terminal demonstration. The demo has no copy action; actionable
  installation instructions belong in the authenticated Computer UI.

- Public channels belong to `features/conversations/` (discovery, join/create,
  shared message UI and authenticated functions) and
  `server/conversations/public-channels.server.ts` (Workspace authorization,
  default-channel enrollment, membership, canonical read/write and ordering).
  Workspace creation enrolls its human creator in `#general` atomically.
  Agent creation and default-channel repair enroll Workspace Agents in `#general`.
  PublicChannels owns mute/mention delivery eligibility; the existing conversation
  repository owns Agent target-scoped reads and eligible-notification recovery,
  and the Agent HTTPS functions enforce its authenticated identity. Workspace human
  roles and invitations belong to `server/workspaces/member-role.server.ts`,
  `member-directory.server.ts`, `features/workspaces/members.functions.ts`, and
  the Settings Members section.

  Creating a channel (`PublicChannels.create`) requires only the existing
  Workspace membership check (ADR 0025: Slack's default — any member may
  create a channel); joining stays open to any member. `PublicChannels.members`
  returns current human/Agent members plus add-candidates and `canAddMembers`
  for any Workspace member to read (true when the actor has a
  `ConversationMember` row in that channel). A channel member calls
  `PublicChannels.addMembers` to add Workspace humans and/or Agents to that
  channel (Slack: you add people to channels you belong to) — this is the one
  entrypoint for enrolling an Agent in a non-default channel; a non-member is
  rejected with `ACCESS_DENIED`. Channel member removal is not implemented:
  `Message.sender` is `onDelete: Restrict` against `ConversationMember`, so
  hard-deleting a member who has sent messages would be rejected by
  PostgreSQL; the planned rule (owner/admin remove from public channels,
  never from `#general`) is a follow-up. `features/conversations/
channels.functions.ts` exposes `loadPublicChannelMembers`/`addPublicChannelMembers`;
  `channel-members-dialog.tsx` is the Web UI, opened from a "Members" button on
  the channel header. Agent creation (`ManageAgents.create`) still requires
  Workspace owner/admin via `assertCanCreateAgents` (Raft: only a
  human-committed action card creates agents). Channels still have no role
  system of their own; private channels are planned but not introduced here.

- Agent-prepared action cards (ADR 0027) belong to
  `server/conversations/action-cards.server.ts`: `ActionCards.prepare`
  resolves every handle in a `channel:create`/`agent:create`/
  `channel:add_member` action to a UUID, reuses the Agent `message send`
  target resolver and membership rule, and creates the posted Message and
  the `ActionCard` row in the same conversation-locked transaction.
  `ActionCards.viewsFor(workspaceId, viewerUserId, messageIds)` is the one
  batched (never per-message) lookup that produces the `actionCard` field on
  `channelMessageView`/`toBrowserMessage`/`mapBrowserMessage`; the shared
  `attachActionCardViews` helper merges it into the channel and
  direct-conversation message-page Server Functions in
  `channels.functions.ts`/`conversations.functions.ts`. A human commits a
  card from `features/conversations/action-card.tsx` (rendered by
  `message-row.tsx` in place of the plain draft-hint line), reusing the
  existing `CreateChannelDialog`/`AgentCreateDialog`
  (`features/agents/agent-create-dialog.tsx`, extracted from the Members
  page's create form so an action card can open it prefilled and
  Computer-locked)/`ChannelMembersDialog` with new optional
  preselect/commit props. `channel:create` and `channel:add_member` commit
  through `action-cards.functions.ts` (`ActionCards.commitChannelCreate`/
  `commitChannelAddMember`, which call `PublicChannels.create`/
  `addMembers` under the committing human's identity, then mark the card);
  `agent:create` commits through the existing `createAgent` Server Function
  (`agents.functions.ts`), which already enforces `assertCanCreateAgents`,
  guarded before by `ActionCards.assertAgentCreateCommittable` and marked
  after by `ActionCards.completeAgentCreate` — every commit path executes
  the real operation first and marks the card `executed` after with a
  conditional `updateMany`, so a double click fails on the operation's own
  uniqueness rule or a harmless `addMembers` no-op (see ADR 0027 "Commit and
  cancel"). `ActionCards.cancel` allows the preparing Agent's owner or a
  Workspace owner/admin, `pending → cancelled`. Both publish the existing
  `ConversationRealtime.messageAvailable`; the browser refreshes just the
  pending cards it is showing via `loadActionCardStates` on that signal and
  on window focus (`conversation-queries.ts`). Agent-facing message reads
  (`toAgentMessage`) append ` [action card: pending|executed|cancelled]`
  to a card message's body so an Agent never claims a resource exists ahead
  of a human's commit.

- Message threads belong to `features/conversations/` (selection, drafts,
  discussion UI, follow controls and authenticated functions),
  `server/conversations/` (send and notification routing), and
  `direct-conversation.repositories.server.ts` (root validation, target-scoped
  ranges, Agent read positions and recovery). `PublicChannels` owns channel
  membership, human read positions, persistent follow state and Agent delivery
  eligibility. A thread uses its root Message identity, never a separate
  conversation or Agent runtime.

- Browser message index and around-window reads belong to the shared
  `features/conversations/` Server Function seam and
  `server/conversations/conversation-history.server.ts`. They are scoped by
  `conversationId` for both direct conversations and public channels; the
  server-side module owns Conversation-type visibility checks and bounded
  history mapping.

- Message-backed Tasks belong to `server/tasks/task-board.server.ts`:
  `TaskBoard.execute(principal, command)` owns authorization, message/task atomic
  creation, numbering, exclusive claims, assignment, card amendments/history,
  resource receipts and status writes. Resource expiry follow-up uses the existing
  Reminder persistence and synchronization, never a second task scheduler.
  TaskBoard also owns server-authored assignment Message creation and the assignee's
  delivery eligibility in that same transaction. A null Message sender is the
  server identity, never a fabricated member; authenticated send adapters always
  supply their member identity. Existing message read/recovery and browser
  projections expose this identity as `system` without changing Agent-send wake rules.
  Task message metadata belongs to the existing message read projections.
  `features/tasks/tasks.functions.ts` exposes `executeTask` to the browser;
  `features/tasks/` owns the board and message actions. Agent Task RPC adapters
  under `server/agents/` call the same TaskBoard, never duplicate business rules.
  `packages/coforge-sdk/tasks.ts` owns the framework-free shared contract.
  `TaskBoard.overview(workspaceId, userId)` owns the browser-only Workspace
  overview query under existing conversation visibility rules;
  `features/tasks/tasks.functions.ts` exposes `loadTaskOverview` and
  `features/tasks/task-overview.tsx` renders it. Task views share status-grouped
  Board/List layout and drag interactions under `features/tasks/`; dnd-kit owns
  pointer/keyboard mechanics, never authorization or persistence. The `/tasks`
  and conversation routes own validated view search state. All status edits
  reuse `executeTask`, with claim semantics and optional revision checks (the
  browser supplies revisions; the approved CDN-aligned Agent CLI need not);
  overview membership metadata only controls available UI actions.

- Workspace Records (weekly reports) belong to `features/records/` (list/detail,
  settings, stats, side comments, and Server Functions) and
  `server/records/record-catalog.server.ts` (cycles, reports, highlights,
  templates, favorites, notes, and comments). Persistence is Prisma under
  Workspace membership. Report bodies use lightweight outline JSON keyed by
  template-dimension tabs. MVP writes only human `user` comments; `assistant`
  authorType and comment `payload` are reserved for later AI side panels.
  The weekly-report assistant's on-demand reads reuse `RecordCatalog` through
  Agent HTTPS `POST /api/agent/v1/weekly-reports`, authorized as the assistant owner User.
  Schema merge requires Frank approval (see ADR 0009).

- Browser realtime connection ownership belongs to `features/realtime/`. The
  `_app` layout owns one Centrifuge connection for the selected Workspace;
  feature modules may subscribe to authorized channels but must not create
  additional browser WebSocket connections. `browser-realtime.tsx` exposes
  `useRealtimeSubscription` for that one connection and owns its client type;
  a channel with a narrower server-issued grant supplies its own subscription
  token to the hook.

- `src/routes/__root.tsx` owns the document shell: HTML, global head, global
  providers, styles, `HeadContent`, and `Scripts`.
- Use pathless layout routes for shared application chrome. The current app
  layout is `src/routes/_app.tsx`; it owns `AppShell` and renders `Outlet`.
- Page routes under `src/routes/_app/` own their page component, loader,
  `beforeLoad`, search validation, head metadata, and pending/error states.
  Do not pass a `page` discriminator into `AppShell` to select page content.
- Keep route files focused on URL ownership and route lifecycle. Put reusable
  business UI and data modules under the owning `src/features/<domain>/`
  directory.
- Prefer this shape as the Web grows:

  ```text
  src/
  ├── routes/
  │   ├── __root.tsx
  │   ├── _app.tsx
  │   └── _app/
  │       ├── index.tsx
  │       ├── computers.tsx
  │       ├── settings.tsx
  │       └── conversations/
  │           ├── index.tsx
  │           └── $conversationId.tsx
  ├── features/
  │   ├── agents/
  │   ├── computers/
  │   ├── conversations/
  │   ├── projects/
  │   ├── profiles/
  │   └── attachments/
  ├── components/
  │   ├── layout/
  │   └── ui/
  ├── server/
  │   ├── auth/
  │   ├── db/
  │   ├── middleware/
  │   └── services/
  └── server.ts
  ```

- Keep `components/layout` limited to layout concerns and `components/ui`
  limited to reusable UI primitives. Do not turn either directory into a
  catch-all for feature behavior.
- `components/base` holds official MIT Untitled UI source installed via its CLI
  for ComboBox and its dependencies. Preserve upstream APIs and interaction logic;
  adapt feature callers instead. `components/ui` still contains compatibility
  adaptations and product-specific primitives, not unmodified official components.
  CoForge color tokens remain authoritative; `.untitled-ui` scopes the official
  components' semantic theme mapping, including their portaled popovers.
  Native button leaves are allowed only in the shared Button/Select/Tooltip
  adapters that implement React Aria render semantics; feature code must use
  components. Official Tooltip `title` props are not native HTML title attributes.
  `features/landing` retains its existing presentation and isolated legacy
  controls; product changes must not alter the public homepage.
- Loading placeholders belong to the feature whose content they represent:
  `features/agents/agents-pending.tsx` owns the Agent list;
  `features/agents/agent-detail-pending.tsx` owns Profile/Activity placeholders;
  `features/computers/computers-pending.tsx` owns Computer loading and local errors;
  `SettingsPending` in `components/settings-content.tsx` owns settings placeholders;
  `features/conversations/conversation-pending.tsx` owns message loading and
  local load errors. Routes select these pending/error views; the shared
  `components/ui/skeleton.tsx` owns decorative placeholder styling only.
  Profile save feedback stays in `SettingsContent`; transient notifications
  use the existing `AppToastProvider` rather than a second notification system.
- `components/ui/empty.tsx` supplies the shared Empty presentation primitives;
  owning features choose their icon, localized copy, and empty-state condition.
- `features/conversations/direct-conversation.tsx` owns the shared conversation
  empty-state layout and compact thread prompt. Direct and channel views supply
  their own identity, media, and copy; they retain their existing composer or join action.
- `components/layout/sidebar/mobile-header.tsx` connects page-owned mobile menu
  controls to `AppShell`'s global navigation drawer, which contains global
  destinations only, never channel or direct-message lists. Pages own their
  titles and actions. `features/conversations/conversation-navigation.tsx`
  owns Chat list/detail selection, retained list scroll and mounted conversation
  drafts on desktop and mobile. At `lg` and above, list and detail stay side by
  side; narrower viewports switch between them. `conversation-directory.tsx` renders the page's
  channel/DM list. Neither sidebar renders conversation lists or their creation actions.
- `features/computers/computer-layout.tsx` owns the analogous Computer
  list/detail selection, return control, list scroll retention, and empty state.
- `features/computers/runtime-usage.tsx` owns Usage interaction eligibility:
  Codex and Claude offer on-demand scanning; Pi, CoForge, and runtimes reporting
  unsupported Usage remain plain, non-focusable identities.
- `features/agents/agents-content.tsx` owns the Members page's mixed human/Agent
  cards, counted type filters, search recovery, and Agent creation dialog.
  Computer prerequisites appear only after requesting Agent creation; runtime
  management remains in Agent detail, not the directory. The per-User weekly-report
  assistant is an internal Agent identity excluded from this directory; its
  Computer/Runtime setup reuses the Agent detail seam. Workspace directory reads
  belong to `features/workspaces/workspaces.functions.ts` and
  `server/workspaces/members.server.ts`; owner-only Agent operations remain separate.
- `src/features/profiles/profile.functions.ts` owns the authenticated current-user
  profile read and description mutation. Avatar bytes and profile persistence
  stay under `src/server/profiles/` and `src/server/db/repositories/`.
- Use TanStack `Link`, `useNavigate`, and typed route APIs for internal
  navigation. Use ordinary anchors only for external URLs or intentional
  document downloads.
- Put shareable filters, pagination, sorting, and tabs in validated route
  search params. Keep ephemeral UI state such as an open Dialog in React
  state unless the dialog must be deep-linkable or browser-history addressable.
- When a mutation changes loader data, await the mutation and invalidate the
  relevant router data with `router.invalidate({ sync: true })` when the next
  UI step requires fresh data.

## Agent status and activity UI

- Cloud Agent reminders belong to `server/reminders/reminders.server.ts`, whose
  public `Reminders` interface owns authorization, recurrence, fire idempotence,
  and snapshot behavior. `server/db/repositories/reminder.repositories.server.ts`
  owns PostgreSQL locking and persistence. The existing authenticated Agent
  HTTPS and Daemon WSS compositions are adapters only; Daemon capability leases
  remain volatile and reminder timer state remains Daemon-owned.

- `server/agents/agent-sessions.server.ts` owns cloud-selected provider session
  references and start/daemon/launch fencing. `AgentSession` is the sole persisted
  owner of native ID/state, scoped by Agent/Workspace/Computer/provider;
  `Agent.runtimeSession` stores only the upstream provider/computer/start-request/
  daemon-instance/launch/session-mode fence and is hydrated from that table;
  acknowledged `agent:session` WSS RPC reports never travel as Activity. Ready
  recovery selects Agents in the cloud; no local transcript scan starts Agents.
- `src/features/agents/agent-activity-avatar.tsx` owns the working activity label
  and accessible recent-activity popover. It consumes newest-first activity from
  the Activity module; it does not interpret provider message text or own transport.
  It renders the cloud-authored unified Agent display; it never reduces raw facts.
- `server/agents/agent-display.server.ts` owns cloud reduction of ordered process
  status and authorized Activity into online/working/thinking/error/offline.
  Its atomic Redis projection renews process leases for 90 seconds and expires
  working/thinking after 60 seconds of server receipt time, returning online while
  the process remains alive. Error remains until recognized activity or reset;
  process expiry yields offline. State expires after 24 hours, while the revision
  counter persists with a Redis server-time floor. RPC and publication adapters
  invoke this seam, never duplicate its transition rules. The current
  `runtimeSession` launch read is a best-effort fence, not a Redis-atomic guarantee.
  `packages/coforge-sdk/agent-display.ts` owns the additive browser display contract.
  Process leases and Activity remain separate Daemon facts, not separate UI states.
- `agent-activity-presentation.ts` projects existing Activity fields into status,
  tool, thinking and output rows for the timeline, recent-activity popover and
  current label. Status detail comes from the backend; tool labels come from
  structured tool names, never commands or paths. `agent-activity-timeline.tsx`
  owns row rendering and on-demand expansion. Current state and expiry decisions
  belong to the cloud reducer, not these presentation functions.
- `agent-environment-editor.tsx` edits only user-declared Agent environment overrides.
  `server/agents/agent-environment.server.ts` owns their authorized persistence and
  restart application. Local inherited environment is never collected or uploaded.
- `workspace-activity-realtime.ts` owns one messages-page Workspace Activity
  subscription and compact initial/reconnect history; avatars never open connections.
- Workspace-scoped Code Agent installation inventory belongs to
  `server/db/repositories/computer-runtime.repositories.server.ts`. Runtime visibility and
  model catalogs are keyed and queried by the trusted `(workspaceId, computerId)` connection;
  a Computer shared with another Workspace must not share publication state or catalog rows.

- `server/computers/computer-metadata.server.ts` owns last-observed OS/executable
  metadata persistence. Ready supplies observations, never creator identity.
  Computer-scoped creator avatar downloads authorize Workspace membership before
  resolving the original Computer owner and reading the existing User avatar store.
- `server/computers/computer-http.server.ts` owns the User-authenticated HTTPS
  composition for Computer setup/attach Workspace lookup and registration. The fixed
  `/api/computer/workspace` and `/api/computer/attach` routes bind `workspace:get` and
  `computer:register`; `ComputerRegistrar` continues to own registration authorization,
  idempotency, and persistence behavior.

- `src/features/agents/agents.functions.ts` owns the authenticated Agent list/create seam;
  server-side Agent persistence, start publication, and ready recovery remain under
  `src/server/agents/` and `src/server/db/repositories/`.
- `server/agents/manage-agents.server.ts` owns Agent create/edit orchestration, including
  runtime selection, credential-aware restart decisions, and public response redaction.
  `AgentRuntimeCredentials` owns Agent/provider-bound encryption; repositories only persist
  the completed runtime config, and Server Function composition supplies encryption lazily.
- `features/agents/agent-reminders.functions.ts` and `server/agents/agent-reminders.server.ts`
  own the owner-only, Workspace-scoped browser read model for bounded Reminder lists and
  expose scheduled Reminders only. Reminder lifecycle and history persistence remain in
  `server/reminders/` and its repository.
- `server/agents/agent-control.server.ts` owns owner-authorized control operations:
  fixed command chains for Restart, Reset Session and Full Reset, receipt-driven
  state transitions, and request/epoch fences. It clears the Session binding at
  the local chain step; Session observations remain independently owned below.
  `features/agents/agent-control.functions.ts` is the browser seam; transport
  receivers under `server/centrifugo/` authenticate claims before applying
  conditional Session/control updates. Current operation progress is not a new
  Agent status or a generic durable command mailbox. Profile buttons submit
  without waiting UI or control-state queries; runtime observations stay in
  Activity. Full Reset still requires destructive confirmation.
- `server/agents/agent-session.server.ts` owns Session snapshot acceptance and
  launch-scoped identity updates. It shares the current control authorization
  guard, but never advances control operations. Unified RPC callbacks route Session
  reports to this acceptance seam; sequenced snapshots validate the upstream launch
  fence before the independent snapshot receiver. Control-result dispatch remains separate.
- `features/agents/agent-skills.functions.ts` owns the authenticated Profile Skills
  query. `server/agents/agent-skills.server.ts` authorizes the Agent owner and
  correlates bounded requests; `server/centrifugo/agent-skills-cache.server.ts`
  stores short-lived request-scoped results, not inventory or canonical data.
  The Profile displays Global/Workspace metadata, never skill bodies or a claim
  that a running session has loaded each entry.
- `src/features/agents/agent-status-realtime.ts` consumes backend display snapshots from the
  initial server response and the existing realtime status channel. It accepts revisions and,
  at display expiry, refreshes the backend and retries on failure without implementing a
  reducer. It retains the last snapshot when refresh fails; an unavailable initial snapshot
  with no prior value is unknown, not offline.
- `src/features/agents/agent-activity.ts` owns the Activity channel, publication
  decoding/scope checks, timeline merging and unresolved-error selection.
  `workspace-activity-realtime.ts` hydrates history and consumes the existing binary Activity
  channel through the shared `features/realtime/` connection. History and live entries
  deduplicate by launch ID/client sequence. Reconnect reloads best-effort history; timeline
  history never independently changes the unified display snapshot.

- Keep Daemon process and Activity facts separate. `agent:status` contains only
  `active` or `inactive`, and Activity retains raw detail/entries. The browser displays only
  the backend-authored online/working/thinking/error/offline projection; backend
  `activity_kind` classification overrides any Daemon-supplied classification.
- Render `agent:activity` fields `detail`, `detailKind`, `entries`, `observedAtMs`,
  and the CoForge `level` extension in an Agent-owned timeline under
  `src/features/agents/`.
- Activity content and labels are **not internationalized**. Use Raft-style
  English activity labels consistently in the timeline, avatar hover and chat
  header. Display backend detail and use Raft-style tool-row formatting; working and
  thinking use the yellow work treatment. Preserve provider text, thinking, errors and warnings in their original
  language and wording, subject to required secret redaction. Do not add Activity
  label translation keys. Navigation, tabs and general UI remain localized.
- Render unknown detail kinds with a generic activity presentation and the
  original detail instead of dropping the record.
- Show command and workspace-relative file path messages as copyable monospace
  text. Never expect or render file contents, diffs, prompts, secrets, or raw
  provider stderr in an activity record.
- The user-approved display-content exception is structured `entries` containing
  provider-exposed assistant text and thinking intended for display. Never
  extract hidden reasoning or copy raw tool arguments, outputs or patches.
  Render that text as plain text, not HTML; redaction is best effort, not a
  guarantee that every sensitive statement can be recognized.

## Type safety and code splitting

- Keep the generated `src/routeTree.gen.ts` out of manual edits; regenerate it
  after adding, moving, or deleting route files.
- Preserve TanStack Router inference. Do not add casts or unnecessary type
  annotations to route params, search, loader data, or navigation options.
- Route components should not be exported as additional public symbols. When
  using a `.lazy.tsx` route file, use `getRouteApi()` rather than importing
  `Route` into the lazy module.
- Keep feature modules out of the shared layout unless they are genuinely
  required on every page. Check production chunk output after adding a large
  feature or dependency.

## Framework constraints

- This app uses TanStack Start, not Next.js. Do not add `app/`, `pages/`,
  `getServerSideProps`, `getStaticProps`, or `"use server"` directives.
- Follow the TanStack guidance listed in the repository-level `AGENTS.md`
  before making changes to routing, data loading, Server Functions, middleware,
  authentication, SSR, or code splitting.
