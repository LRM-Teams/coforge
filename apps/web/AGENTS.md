# Web application instructions

These instructions apply to `apps/web` and refine the repository-level
instructions for the TanStack Start Web/backend modular monolith.

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

- Web Push belongs to `features/notifications/` for authenticated settings,
  permission/subscription UI, and the Service Worker contract. Server-only
  preference and per-browser subscription persistence, VAPID key loading,
  eligibility, encrypted delivery, and invalid-subscription cleanup belong to
  `server/notifications/`. Conversation send orchestration may invoke that
  public notification seam only after the canonical Message commits; it must
  not own Web Push protocol or persistence details. Channel mute eligibility
  remains owned by PublicChannels. Test push uses the same server delivery
  seam as committed-message push.

- Public channels belong to `features/conversations/` (discovery, join/create,
  shared message UI and authenticated functions) and
  `server/conversations/public-channels.server.ts` (Workspace authorization,
  default-channel enrollment, membership, canonical read/write and ordering).
  Workspace creation enrolls its human creator in `#general` atomically.
  Agent creation and default-channel repair enroll Workspace Agents in `#general`.
  PublicChannels owns mute/mention delivery eligibility; the existing conversation
  repository owns Agent target-scoped reads and eligible-notification recovery,
  and the Agent HTTPS functions enforce its authenticated identity. No additional
  Agent enrollment entrypoint, invitations or roles are introduced.

- Direct-message threads belong to `features/conversations/` (selection, drafts,
  discussion UI and authenticated functions), `server/conversations/` (send
  routing), and `direct-conversation.repositories.server.ts` (root validation,
  target-scoped ranges, read positions and recovery). A thread uses its root
  Message identity, never a separate conversation or Agent runtime.

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
  │   ├── notifications/
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

- `src/features/agents/workspace-activity-realtime.ts` owns one messages-page Activity
  subscription and reconnect history merge for the selected Workspace. Avatars consume
  its shared result, never open sockets or fetch full Agent details individually.
- `AgentActivityRepository.listForMember` provides the authorized, compact per-Agent
  history snapshot; `agent-activity.functions.ts` is its authenticated browser seam.
- `src/features/agents/agent-activity-avatar.tsx` owns the working activity label
  and accessible recent-activity popover. It consumes newest-first activity from
  the Activity module; it does not interpret provider message text or own transport.
  Online presence remains independent. Stale observations clear the working label.
- `src/features/agents/agents.functions.ts` owns the authenticated Agent list/create seam;
  server-side Agent persistence, start publication, and ready recovery remain under
  `src/server/agents/` and `src/server/db/repositories/`.
- `src/features/agents/agent-status-realtime.ts` owns the browser status event contract and
  state updates. Redis supplies initial/reconnect snapshots; Centrifugo publications update
  the open page without periodic backend polling.
- `src/features/agents/agent-activity.ts` owns timeline merging and unresolved-error selection;
  `agent-activity-realtime.ts` hydrates history and consumes the existing binary Activity
  channel. History and live entries deduplicate by launch ID/client sequence. Reconnect
  reloads best-effort history; neither a gap nor a completed turn changes online status.

- Keep Agent status and activity separate. `agent:status` contains only
  `active` or `inactive`; the UI presents those values as online or offline and
  must not infer more statuses from activity text.
- Render the fixed `agent:activity` fields `activity`, `level`, `message`, and
  `occurred_at` in an Agent-owned timeline under `src/features/agents/`.
- Localize the label and icon selected by `activity`, but preserve provider
  error and warning `message` text in its original language and wording.
- Render unknown activity values with a generic activity presentation and the
  original message instead of dropping the record.
- Show command and workspace-relative file path messages as copyable monospace
  text. Never expect or render file contents, diffs, prompts, secrets, or raw
  provider stderr in an activity record.

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
