# Web application instructions

These rules apply to `apps/web`, the TanStack Start Web/backend modular
monolith, and refine the repository-level `AGENTS.md`. Directory-specific rules
live in nested `AGENTS.md` files listed at the end.

## Product design

- Before designing or changing product UI, read and follow
  [the product design guidance](../../docs/design/README.md). It is the single design
  document for `apps/web`; colors and fonts live in
  [design tokens](../../docs/design-tokens.md). Do not create another design or
  UI-guideline document; change `docs/design/` instead.
- For list/detail pages and empty states apply sections 2.1–2.2 and 5.1, and
  run the checklist and acceptance checks in section 6. State why a different
  user task requires an exception before implementing one. Do not treat
  existing pages as automatic exceptions; adapt the affected flow when changing
  it, without expanding into unrelated page redesigns.
- Hard rules that apply to every UI change (details in `docs/design/`):
  - Mockups: when a design mockup is provided, it wins over the defaults in
    `docs/design/`; implement it with the components and units below and
    update the conflicting rule in the same change. Ask before inventing data
    or concepts the mockup shows but the product lacks (§1).
  - Components (product UI; `features/landing` keeps its Spell / Magic UI
    motion components): only official Untitled UI components, unmodified, and
    the primitives listed in `components/ui/README.md`, per §7 including its
    listed exceptions. Icons only from `@untitledui/icons`; vendor logos from
    `@lobehub/icons-static-svg`.
  - Sizes: anything that affects layout or reading (font size, spacing, width,
    height, radius, icon/avatar size, offsets) uses rem — the Tailwind scale,
    or a rem arbitrary value such as `w-[18rem]`; never `w-[280px]`,
    `text-[10px]`, or numeric inline `style` sizes. px is only for hairlines
    (border, ring, outline, divider), stroke widths, shadows/blur, and
    positions and sizes measured from the DOM (§12).
  - Colors: semantic tokens only, no hex or `dark:` color overrides (§11).
  - Feedback: a toast only confirms an action; anything the user must see,
    handle, or come back to stays inline (§13). Toasts go through the existing
    `AppToastProvider`; do not add a second notification system.
- Do not apply marketing-page defaults from `design-taste-frontend` to the
  product workspace.
- Keep supplemental explanations behind accessible, on-demand help when
  appropriate; keep essential constraints, errors, and risks visible. Help
  must work for keyboard and touch users, not only on hover.
- Loading placeholders and local load errors belong to the feature whose
  content they represent (for example `features/agents/agents-pending.tsx`);
  routes select them, and `components/ui/skeleton.tsx` supplies decorative
  styling only.
- Derive a slug from a display name with `src/lib/slug.ts`, as Project and
  Workspace creation do.

## TanStack Start boundaries

- This app uses TanStack Start, not Next.js. Do not add `app/`, `pages/`,
  `getServerSideProps`, `getStaticProps`, or `"use server"` directives.
- Follow the TanStack guidance listed in the repository-level `AGENTS.md`
  before changing routing, data loading, Server Functions, middleware,
  authentication, SSR, or code splitting.
- `src/server.ts` is the runtime entry point. Keep it limited to request
  middleware and the Start server handler; do not put feature behavior there.
- Use a Server Function (`createServerFn`) for data and mutations called by
  the Web UI. Put the public function at the owning feature seam, for example
  `src/features/agents/agents.functions.ts`.
- Follow TanStack Start's file naming: `.functions.ts` for `createServerFn`
  wrappers (importable anywhere), `.server.ts` for server-only code, and no
  suffix for client-safe code. Everything under `src/server/` is server-only:
  every TypeScript module there ends in `.server.ts` (data files such as the Manual topics are read only by those modules), and `vite.config.ts` import
  protection denies both `*.server.*` and `src/server/**` in the client build.
  Code the browser also needs (schemas, slugs, pure formatting) lives in the
  owning `features/` module or `src/lib/`, never in `src/server/`. Server
  Functions and function middleware live in `features/`, not `src/server/`.
- Import through `#src/` (see the root `AGENTS.md`). Untitled UI's CLI writes
  `@/` imports; rewrite them to `#src/` when adding a component.
- Route loaders may call Server Functions, but must not access a database,
  filesystem, secret, or server-only SDK directly. Do not self-fetch a
  relative `/api/...` URL from an SSR loader.
- Validate Server Function inputs and enforce authorization on the server.
  Router `beforeLoad` guards improve navigation UX but are not a security
  boundary.
- Use a Server Route under `src/routes/api/` only when the raw HTTP contract is
  part of the product: webhooks, third-party REST clients, feeds, or file
  responses. Do not create an API route just to serve data to a page. A raw
  route stays a thin adapter over the owning server module, which enforces
  authorization.
- Use TanStack `Link`, `useNavigate`, and typed route APIs for internal
  navigation. Use ordinary anchors only for external URLs or intentional
  document downloads.
- Put shareable filters, pagination, sorting, and tabs in validated route
  search params. Keep ephemeral UI state such as an open Dialog in React
  state unless the dialog must be deep-linkable or browser-history addressable.
- When a mutation changes loader data, await it, then call
  `router.invalidate({ sync: true })` if the next UI step needs fresh data.
  Chat sidebar and Tasks page changes are TanStack DB optimistic actions
  instead, and a change made outside them re-reads their Query (see
  `src/features/conversations/AGENTS.md`, `src/features/tasks/AGENTS.md`).
- Preserve TanStack Router inference. Do not add casts or unnecessary type
  annotations to route params, search, loader data, or navigation options.
- Keep feature modules out of the shared layout unless they are genuinely
  required on every page. Check production chunk output after adding a large
  feature or dependency.

## PostgreSQL and Prisma

- Prisma is the Web/backend database standard. Use the repository's Prisma
  skills for CLI, Client API, database setup, and Prisma upgrades before
  changing database code.
- Keep the Prisma schema, generated client usage, repositories, and migrations
  on the server side. UI routes and feature components call a Server Function
  or server module instead of importing Prisma.
- Keep `prisma`, `@prisma/client`, and the PostgreSQL driver adapter on the
  same supported major version, pinned by the workspace lockfile. Use the
  repository's Bun-compatible Prisma setup rather than adding an alternate
  database client.
- Use PostgreSQL for database-semantic tests; do not silently substitute SQLite.
- Read the database URL and credentials from runtime environment/secret
  injection. Local development uses the project's Docker PostgreSQL; managed
  PostgreSQL changes must not leak provider-specific details into domain code.

## Module map

Each line names a directory under `src/` (unless noted) and its single
responsibility.

- `routes/` — URL ownership and route lifecycle; `routes/api/` raw HTTP routes.
- `components/` — `base/` and `application/` official Untitled UI source,
  `ui/` sanctioned primitives, `layout/` app chrome, `foundations/` logos and
  icons, `spell/` and `magicui/` landing-page motion.
- `lib/` shared pure helpers; `hooks/` shared React hooks; `utils/` Untitled
  UI class helpers.
- `features/agents/` — Members page, Agent creation, profile panel, control buttons, and Agent status and Activity display.
- `features/computers/` — Computer list/detail, setup, and Runtime Usage.
- `features/conversations/` — channels, direct messages, threads, composer, message rendering, action cards, saved messages, and the sidebar lists.
- `features/device-auth/` — device-code verification page.
- `features/errors/` — page-level load-error view.
- `features/inbox/` — the Activity page: conversations and threads not yet marked Done.
- `features/install/` — Computer install command text.
- `features/integrations/` — Settings → Integrations GitHub view and functions.
- `features/landing/` — the public homepage.
- `features/notifications/` — browser push lifecycle and in-page notifications.
- `features/panel-tabs/` — each member's saved panel tab order.
- `features/profiles/` — current-user profile read and description update.
- `features/projects/` — Projects directory, project detail, file browser,
  and project settings page.
- `features/realtime/` — the one browser Centrifuge connection.
- `features/records/` — Workspace Records (see the last section).
- `features/settings/` — preference pages and device-local preferences.
- `features/search/` — the Workspace search page (`/search`): filters, matching channels, Agents and Computers, message results with their preview, and the browser-local search history and frequently used places.
- `features/tasks/` — Task board, list, overview, and message task actions.
- `features/workspaces/` — Workspace switcher and creation, member directory reads, invitations, human roles, and the last page `/` returns to.
- `server/agents/` — Agent lifecycle, control, sessions, display reduction,
  visibility, deletion, and the Agent HTTPS API.
- `server/attachments/` — attachment upload sessions and delivery.
- `server/auth/` — login, sessions, device auth, API keys, and auth guards.
- `server/centrifugo/` — Centrifugo proxies, RPC receivers, and short-lived
  result caches.
- `server/computers/` — Computer registration, metadata, restart and upgrade
  operations, and runtime visibility.
- `server/conversations/` — public channels, channel authority, stopping and resuming a channel's Agents, direct messages, history, message search, action cards, reactions, and conversation realtime.
- `server/db/` — the Prisma client, repositories (a DM's list preferences apart from its messages; the Agent attention rule in `agent-attention`; an Agent target's send context window in `agent-target-context`), and the shared unique-violation check.
- `server/errors/` — public error mapping and request error handling.
- `server/files/` — file storage, delivery, and uploaded-image validation.
- `server/http/`, `server/install/`, `server/observability/` — public origin,
  install scripts, and tracing.
- `server/inbox/` — the Activity inbox read model and its Done and read-all writes.
- `server/integrations/` — GitHub connection, configuration, and webhooks.
- `server/notifications/` — Web Push and in-page notification delivery.
- `server/profiles/` — user avatars.
- `server/projects/` — project settings, images, and repository file download.
- `server/records/` — Workspace Records (see the last section).
- `server/reminders/` — cloud Agent Reminders.
- `server/tasks/` — the message-backed TaskBoard, the Tasks page's overview reads, its Task view, history records, and notice wording.
- `server/workspaces/` — Workspace catalog, selection, enrollment, member
  roles, and member directory.
- `prisma/` (app root) — schema and migrations; `messages/` — UI translations.

## Nested rules

- Rules for `prisma/` → [`prisma/AGENTS.md`](prisma/AGENTS.md)
- Rules for `src/routes/` → [`src/routes/AGENTS.md`](src/routes/AGENTS.md)
- Rules for `src/components/` → [`src/components/AGENTS.md`](src/components/AGENTS.md)
- Date and time rules for all of `apps/web` (Temporal, `Intl`, `useHydrated`) → [`src/lib/AGENTS.md`](src/lib/AGENTS.md)
- Rules for `src/features/agents/` → [`src/features/agents/AGENTS.md`](src/features/agents/AGENTS.md)
- Rules for `src/features/computers/` → [`src/features/computers/AGENTS.md`](src/features/computers/AGENTS.md)
- Rules for `src/features/conversations/` → [`src/features/conversations/AGENTS.md`](src/features/conversations/AGENTS.md)
- Rules for `src/features/landing/` → [`src/features/landing/AGENTS.md`](src/features/landing/AGENTS.md)
- Rules for `src/features/panel-tabs/` → [`src/features/panel-tabs/AGENTS.md`](src/features/panel-tabs/AGENTS.md)
- Rules for `src/features/projects/` → [`src/features/projects/AGENTS.md`](src/features/projects/AGENTS.md)
- Rules for `src/features/realtime/` → [`src/features/realtime/AGENTS.md`](src/features/realtime/AGENTS.md)
- Rules for `src/features/tasks/` → [`src/features/tasks/AGENTS.md`](src/features/tasks/AGENTS.md)
- Rules for `src/server/agents/` → [`src/server/agents/AGENTS.md`](src/server/agents/AGENTS.md)
- Rules for `src/server/centrifugo/` → [`src/server/centrifugo/AGENTS.md`](src/server/centrifugo/AGENTS.md)
- Rules for `src/server/computers/` → [`src/server/computers/AGENTS.md`](src/server/computers/AGENTS.md)
- Rules for `src/server/conversations/` → [`src/server/conversations/AGENTS.md`](src/server/conversations/AGENTS.md)
- Rules for `src/server/db/` → [`src/server/db/AGENTS.md`](src/server/db/AGENTS.md)
- Rules for `src/server/integrations/` → [`src/server/integrations/AGENTS.md`](src/server/integrations/AGENTS.md)
- Rules for `src/server/notifications/` → [`src/server/notifications/AGENTS.md`](src/server/notifications/AGENTS.md)
- Rules for `src/server/projects/` → [`src/server/projects/AGENTS.md`](src/server/projects/AGENTS.md)
- Rules for `src/server/reminders/` → [`src/server/reminders/AGENTS.md`](src/server/reminders/AGENTS.md)
- Rules for `src/server/tasks/` → [`src/server/tasks/AGENTS.md`](src/server/tasks/AGENTS.md)
- Rules for Records (`src/features/records/`, `src/server/records/`) → [`src/features/records/AGENTS.md`](src/features/records/AGENTS.md)
