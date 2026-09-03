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

### Prisma, repositories, and business rules

- Prisma Repository 只负责查询、持久化、事务和数据库约束；不要在其中
  编排完整业务流程。
- 用户授权、产品规则和跨模块流程放在所属 feature 的 Use Case / Domain
  模块中，并通过 Repository interface 调用数据访问。
- Server Function 和 HTTP Route 只做认证、输入校验、依赖组装和调用 Use
  Case，不要把业务流程直接写进去。
- 本次遇到的具体问题：按用户名查找用户、创建会话、读取消息原先都在
  `PrismaDirectConversationRepository` 中；以后应放在类似
  `ReadDirectMessages` 的 Use Case 中，Repository 只接收已确定的
  `conversationId` 并读取数据。
- 不要为了形式主义给每个 Prisma 调用都增加一层；只有存在业务规则、复用
  或测试价值时才抽取 Repository / Use Case。

参考：
https://www.prisma.io/docs/orm/prisma-client/queries/transactions
https://martinfowler.com/eaaCatalog/repository.html

## Route and page organization

- `src/routes/__root.tsx` owns the document shell: HTML, global head, global
  providers, styles, `HeadContent`, and `Scripts`.
- `src/features/errors/` owns safe user-facing error presentation. Unknown
  exceptions must never be rendered directly; page-load failures use a local
  route error component, while failures caused by user actions use toasts.
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

- **Localization boundary:** Every user-visible sentence, label, button name,
  status, error, and accessibility label must come from the generated
  Paraglide messages in `messages/<locale>/`. Do not put translated English or
  Chinese text directly in TSX, feature modules, route files, or server
  responses. Provider-owned names and messages, protocol values, URLs, and
  language endonyms in a locale picker are not translations and may remain
  source data. When adding a message, add it to every supported locale and
  regenerate `src/paraglide` with `bun run generate-i18n`.
- **Localization tests:** Test translated UI through the real message catalog
  and exercise each supported locale for new user-visible behavior. Locale
  resolution must be explicit at request/render boundaries; do not use a
  process-wide locale override in application code. Tests that need to switch
  Paraglide's process-wide test locale must restore it in `afterEach` and must
  remain isolated from concurrent locale-sensitive tests.

- `src/features/computers/computers.functions.ts` owns authenticated Computer
  listing and external runtime visibility mutations. Runtime visibility policy
  and persistence belong under `src/server/computers/` and
  `src/server/db/repositories/`; the UI may only render and invoke those
  authenticated operations.
- `src/features/agents/agents.functions.ts` owns the authenticated Agent list/create seam;
  it also owns owner-only Agent runtime credential mutations. Server-side Agent
  persistence, runtime credential encryption, start publication, launch authorization,
  and ready recovery remain under `src/server/agents/`, `src/routes/api/`, and
  `src/server/db/repositories/`. The encrypted API key envelope is stored inside
  `runtimeConfig.provider`; neither plaintext nor the encrypted envelope may enter an
  Agent detail response or Workspace publication.

- Keep Agent status and activity separate. `agent:status` contains only
  `online` or `offline`; do not infer more statuses from activity text.
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
