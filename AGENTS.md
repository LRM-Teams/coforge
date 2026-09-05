<!-- intent-skills:start -->
# TanStack Intent - before editing files, run the matching guidance command.
tanstackIntent:
  - id: "@tanstack/react-start#lifecycle/migrate-from-nextjs"
    run: "cat .agents/skills/tanstack-react-start/lifecycle/migrate-from-nextjs/SKILL.md"
    for: "Step-by-step migration from Next.js App Router to TanStack Start: route definition conversion, API mapping, server function conversion from Server Actions, middleware conversion, data fetching pattern changes."
  - id: "@tanstack/react-start#react-start"
    run: "cat .agents/skills/tanstack-react-start/SKILL.md"
    for: "React bindings for TanStack Start: createStart, StartClient, StartServer, React-specific imports, re-exports from @tanstack/react-router, full project setup with React, useServerFn hook."
  - id: "@tanstack/react-start#react-start/server-components"
    run: "cat .agents/skills/tanstack-react-start/server-components/SKILL.md"
    for: "Implement, review, debug, and refactor TanStack Start React Server Components in React 19 apps. Use when tasks mention @tanstack/react-start/rsc, renderServerComponent, createCompositeComponent, CompositeComponent, renderToReadableStream, createFromReadableStream, createFromFetch, Composite Components, React Flight streams, loader or query owned RSC caching, router.invalidate, structuralSharing: false, selective SSR, stale names like renderRsc or .validator, or migration from Next App Router RSC patterns. Do not use for generic SSR or non-TanStack RSC frameworks except brief comparison."
  - id: "@tanstack/router-core#router-core"
    run: "cat .agents/skills/tanstack-router-core/SKILL.md"
    for: "Framework-agnostic core concepts for TanStack Router: route trees, createRouter, createRoute, createRootRoute, createRootRouteWithContext, addChildren, Register type declaration, route matching, route sorting, file naming conventions. Entry point for all router skills."
  - id: "@tanstack/router-core#router-core/auth-and-guards"
    run: "cat .agents/skills/tanstack-router-core/auth-and-guards/SKILL.md"
    for: "Route protection with beforeLoad, redirect()/throw redirect(), isRedirect helper, authenticated layout routes (_authenticated), non-redirect auth (inline login), RBAC with roles and permissions, auth provider integration (Auth0, Clerk, Supabase), router context for auth state."
  - id: "@tanstack/router-core#router-core/code-splitting"
    run: "cat .agents/skills/tanstack-router-core/code-splitting/SKILL.md"
    for: "Automatic code splitting (autoCodeSplitting), .lazy.tsx convention, createLazyFileRoute, createLazyRoute, lazyRouteComponent, getRouteApi for typed hooks in split files, codeSplitGroupings per-route override, splitBehavior programmatic config, critical vs non-critical properties."
  - id: "@tanstack/router-core#router-core/data-loading"
    run: "cat .agents/skills/tanstack-router-core/data-loading/SKILL.md"
    for: "Route loader option, loaderDeps for cache keys, staleTime/gcTime/ defaultPreloadStaleTime SWR caching, pendingComponent/pendingMs/ pendingMinMs, errorComponent/onError/onCatch, beforeLoad, router context and createRootRouteWithContext DI pattern, router.invalidate, Await component, deferred data loading with unawaited promises."
  - id: "@tanstack/router-core#router-core/navigation"
    run: "cat .agents/skills/tanstack-router-core/navigation/SKILL.md"
    for: "Link component, useNavigate, Navigate component, router.navigate, ToOptions/NavigateOptions/LinkOptions, from/to relative navigation, activeOptions/activeProps, preloading (intent/viewport/render), preloadDelay, navigation blocking (useBlocker, Block), createLink, linkOptions helper, scroll restoration, MatchRoute."
  - id: "@tanstack/router-core#router-core/not-found-and-errors"
    run: "cat .agents/skills/tanstack-router-core/not-found-and-errors/SKILL.md"
    for: "notFound() function, notFoundComponent, defaultNotFoundComponent, notFoundMode (fuzzy/root), errorComponent, CatchBoundary, CatchNotFound, isNotFound, NotFoundRoute (deprecated), route masking (mask option, createRouteMask, unmaskOnReload)."
  - id: "@tanstack/router-core#router-core/path-params"
    run: "cat .agents/skills/tanstack-router-core/path-params/SKILL.md"
    for: "Dynamic path segments ($paramName), splat routes ($ / _splat), optional params ({-$paramName}), prefix/suffix patterns ({$param}.ext), useParams, params.parse/stringify, pathParamsAllowedCharacters, i18n locale patterns."
  - id: "@tanstack/router-core#router-core/search-params"
    run: "cat .agents/skills/tanstack-router-core/search-params/SKILL.md"
    for: "validateSearch, search param validation with Zod/Valibot/ArkType adapters, fallback(), search middlewares (retainSearchParams, stripSearchParams), custom serialization (parseSearch, stringifySearch), search param inheritance, loaderDeps for cache keys, reading and writing search params."
  - id: "@tanstack/router-core#router-core/ssr"
    run: "cat .agents/skills/tanstack-router-core/ssr/SKILL.md"
    for: "Non-streaming and streaming SSR, RouterClient/RouterServer, renderRouterToString/renderRouterToStream, createRequestHandler, defaultRenderHandler/defaultStreamHandler, HeadContent/Scripts components, head route option (meta/links/styles/scripts), ScriptOnce, automatic loader dehydration/hydration, memory history on server, data serialization, document head management."
  - id: "@tanstack/router-core#router-core/type-safety"
    run: "cat .agents/skills/tanstack-router-core/type-safety/SKILL.md"
    for: "Full type inference philosophy (never cast, never annotate inferred values), Register module declaration, from narrowing on hooks and Link, strict:false for shared components, getRouteApi for code-split typed access, addChildren with object syntax for TS perf, LinkProps and ValidateLinkOptions type utilities, as const satisfies pattern."
  - id: "@tanstack/router-plugin#router-plugin"
    run: "cat .agents/skills/tanstack-router-plugin/SKILL.md"
    for: "TanStack Router bundler plugin for route generation and automatic code splitting. Supports Vite, Webpack, Rspack, and esbuild. Configures autoCodeSplitting, routesDirectory, target framework, and code split groupings."
  - id: "@tanstack/start-client-core#start-core"
    run: "cat .agents/skills/tanstack-start-client-core/SKILL.md"
    for: "Core overview for TanStack Start: tanstackStart() Vite plugin, getRouter() factory, root route document shell (HeadContent, Scripts, Outlet), client/server entry points, routeTree.gen.ts, tsconfig configuration. Entry point for all Start skills."
  - id: "@tanstack/start-client-core#start-core/auth-server-primitives"
    run: "cat .agents/skills/tanstack-start-client-core/auth-server-primitives/SKILL.md"
    for: "Server-side authentication primitives for TanStack Start: session cookies (HttpOnly, Secure, SameSite, __Host- prefix), session read/issue/destroy via createServerFn and middleware, OAuth authorization-code flow with state and PKCE, password-reset enumeration defense, CSRF for non-GET RPCs, rate limiting auth endpoints, session rotation on privilege change. Pairs with router-core/auth-and-guards for the routing side."
  - id: "@tanstack/start-client-core#start-core/deployment"
    run: "cat .agents/skills/tanstack-start-client-core/deployment/SKILL.md"
    for: "Deploy to Cloudflare Workers, Netlify, Vercel, Node.js/Docker, Bun, Railway. Selective SSR (ssr option per route), SPA mode, static prerendering, ISR with Cache-Control headers, SEO and head management."
  - id: "@tanstack/start-client-core#start-core/execution-model"
    run: "cat .agents/skills/tanstack-start-client-core/execution-model/SKILL.md"
    for: "Isomorphic-by-default principle, environment boundary functions (createServerFn, createServerOnlyFn, createClientOnlyFn, createIsomorphicFn), ClientOnly component, useHydrated hook, import protection, dead code elimination, environment variable safety (VITE_ prefix, process.env)."
  - id: "@tanstack/start-client-core#start-core/middleware"
    run: "cat .agents/skills/tanstack-start-client-core/middleware/SKILL.md"
    for: "createMiddleware, request middleware (.server only), server function middleware (.client + .server), context passing via next({ context }), sendContext for client-server transfer, global middleware via createStart in src/start.ts, middleware factories, method order enforcement, fetch override precedence."
  - id: "@tanstack/start-client-core#start-core/server-functions"
    run: "cat .agents/skills/tanstack-start-client-core/server-functions/SKILL.md"
    for: "createServerFn (GET/POST), validator (Zod or function), useServerFn hook, server context utilities (getRequest, getRequestHeader, setResponseHeader, setResponseStatus), error handling (throw errors, redirect, notFound), streaming, FormData handling, file organization (.functions.ts, .server.ts)."
  - id: "@tanstack/start-client-core#start-core/server-routes"
    run: "cat .agents/skills/tanstack-start-client-core/server-routes/SKILL.md"
    for: "Server-side API endpoints using the server property on createFileRoute, HTTP method handlers (GET, POST, PUT, DELETE), createHandlers for per-handler middleware, handler context (request, params, context), request body parsing, response helpers, file naming for API routes."
  - id: "@tanstack/start-server-core#start-server-core"
    run: "cat .agents/skills/tanstack-start-server-core/SKILL.md"
    for: "Server-side runtime for TanStack Start: createStartHandler, request/response utilities (getRequest, setResponseHeader, setCookie, getCookie, useSession), three-phase request handling, AsyncLocalStorage context."
  - id: "@tanstack/virtual-file-routes#virtual-file-routes"
    run: "cat .agents/skills/tanstack-virtual-file-routes/SKILL.md"
    for: "Programmatic route tree building as an alternative to filesystem conventions: rootRoute, index, route, layout, physical, defineVirtualSubtreeConfig. Use with TanStack Router plugin's virtualRouteConfig option."
<!-- intent-skills:end -->

# CoForge repository instructions

These instructions apply to the entire repository.

## Read the architecture first

- Read [`docs/architecture.md`](docs/architecture.md) before changing package boundaries, process ownership, transport, delivery semantics, persistence, infrastructure, or runtime versions.
- Treat that document as the canonical architecture source. Update it in the same change whenever an architectural decision changes.
- Keep `docs/architecture.md` as the single maintained architecture source; do not create a duplicate HTML companion.
- Do not turn an unresolved question into code or a repository convention. Present the options and trade-offs in `#coforge`, then record the decision before implementation; use Frank's approval only when the decision meets a gate below.

## Module design and implementation discipline

- Treat `coforge-computer` and `coforge-daemon` as large, long-lived products.
  Before adding a feature, identify its owning module and its public seam; do
  not put new business logic in the nearest command, entrypoint, or transport
  file merely because it is convenient.
- Keep CLI commands thin. A command may parse arguments, invoke an
  application use case, and format the result for a human. Workspace lookup,
  authentication, registration, runtime discovery, persistence, process
  supervision, and protocol encoding belong to reusable modules below the
  command layer.
- Keep the abstraction gradient explicit: upper layers express business
  intent (`setupComputer`, `registerComputer`, `startDaemonRuntime`); middle
  layers coordinate domain operations (`getBySlug`, `buildRegistration`,
  `ensureStarted`); lower layers expose implementation details (`encode`,
  `writeFrame`, `spawn`, `flush`). Do not create cross-layer methods such as
  `findWorkspaceAndRegisterComputer` or
  `setupAndSendProtobufOverSocket`.
- Dependencies point downward. Entry points and commands may depend on
  application/domain modules; domain modules may depend on ports/contracts;
  infrastructure modules implement those ports. Domain code must not import
  Commander, terminal UI, filesystem paths, sockets, database clients, or
  provider-specific agent parsers.
- Name modules after stable domain concepts and one responsibility. Prefer
  names such as `WorkspaceCatalog`, `WorkspacePicker`, `ComputerRegistrar`,
  `RuntimeInventory`, `MachineIdentity`, `CredentialStore`, and
  `AgentRuntimePool`. Avoid vague names such as `Helper`, `Utils`,
  `Service`, `Resolver`, or `Manager` unless the name is an established
  domain role with a narrowly defined responsibility.
- Keep terminology consistent across code, protocol, logs, and documentation.
  Use one convention for each concept; do not alternate between snake_case,
  camelCase, and arbitrary synonyms for the same public field or event.
- Define the module map in the owning app's `AGENTS.md` before reorganizing or
  adding a feature. If the ownership or boundary is unclear, stop and record
  the design options and decision before writing implementation code.
- For behavior changes, establish the public module seam and regression test
  first. Test application/domain behavior independently from CLI rendering,
  transport framing, and provider-specific adapters.

## Decision gates

- Obtain Frank's explicit approval before changing architecture, database schema, wire protocol, licensing, security boundaries, or another decision with broad or difficult-to-reverse impact. Ordinary reversible implementation choices use the MVP fast lane below.
- Prefer a mature maintained framework when it satisfies the requirements. Propose custom infrastructure only after documenting the gap, maintenance burden, and alternatives.
- Base technical proposals and implementations on current official documentation, official repositories, and official migration guides. Do not rely on remembered or built-in knowledge for versions, APIs, configuration, or support status.
- For each broad or difficult-to-reverse technical proposal, cite its official sources and state the problem, candidates, maturity, license, runtime compatibility, operational cost, migration/rollback impact, recommendation, and unresolved risks. Mark experimental or undocumented behavior explicitly.
- Do not add or change a repository license without Frank's explicit approval.
- Establish formatting and lint checks before feature implementation, and make them required CR checks once adopted.

## Collaboration and delivery

- Follow the lightweight, branch-based [GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow). Create every change on a short-lived feature branch from the latest `origin/main`; use a clear prefix such as `feat/`, `fix/`, `docs/`, or `chore/`. Do not use a long-lived `dev` branch.
- Keep MVP branches to one small objective and, as a rule, merge or close them within the same working day. Prefer a sequence of small CRs to a multi-day feature branch.
- Never commit or push directly to `main`. A change reaches `main` only through a CR/PR with passing required checks and at least one approval from a reviewing Agent. Authors must not self-approve their own CR.
- Use the MVP fast lane for ordinary implementation and documentation: one Agent review, the short automated checks, and immediate squash/rebase merge once feedback is resolved. Target a 5–10 minute review-to-merge cycle; Frank does not need to approve each ordinary CR.
- Frank's explicit approval remains required for the decision gates above and for changes to architecture, database schema, wire protocol, licensing, security boundaries, or other decisions with broad or difficult-to-reverse impact.
- Keep each branch and CR focused on one concern. Preserve unrelated work and coordinate in `#coforge` before touching files another contributor has claimed.
- Before requesting final review, fetch and rebase the branch onto the latest `origin/main`. Never force-push `main` or another contributor's branch.
- Use concise English Conventional Commit messages: `<type>(optional-scope): imperative summary` (for example, `docs: refine delivery guarantees`).
- Use the repository owner's GitHub identity for commits: `me-frankan <me.frankan@gmail.com>`. Never commit with an Agent name or Agent email.
- Respect ownership claimed in `#coforge`. Coordinate before editing another agent's active files or changing a shared contract.
- Amend or rebase mistakes on the feature branch before review. Do not add revert commits merely to clean up work that has not been merged.
- Keep `main` history clean and linear by using the repository's approved squash/rebase merge strategy, then delete the merged branch; do not create gratuitous merge commits.
- A CR must describe its scope, approved decisions, official source links for technical choices, tests and checks run, known risks, and any follow-up work. Do not merge while review comments remain unresolved.
- During MVP, keep required CI short: formatting/linting, type checking, relevant tests, and build. Add slower checks only when their risk reduction justifies the feedback delay. GitHub documents reviews and status checks as independently configurable [branch protection options](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
- A task is complete only after the relevant short checks pass and the CR is approved. If a check does not exist yet, state that clearly in the CR.
- Develop behavioral changes with test-driven development. Agree the public test seam first, then work in vertical slices: one failing test followed by the minimum implementation that passes it.
- Start bug fixes with a regression test. Do not remove or weaken a valid test merely to make CI pass.
- Keep refactoring in the independent review stage rather than expanding a red-green implementation slice.

## Testing

- When writing or modifying tests, investigating test failures, or reviewing test changes, read and follow [the testing guidance](docs/agents/testing.md). Unrelated tasks do not require loading this document.

## Toolchain

- Use `mise` as the repository's development tool and version manager.
- Treat `mise.toml` as the source of truth for tool versions once present. Run `mise install`, then prefer `mise run <task>` or `mise exec -- <command>` over unpinned global tools.
- Run `mise run test`, `mise run check`, and `mise run build` before submitting a change; CI runs them in that order.
- Do not silently change a runtime or tool version. Update `mise.toml`, affected lockfiles, CI, and architecture documentation together.
- Protobuf schemas under `packages/protocol/proto` must pass `buf lint` and
  `buf format --diff --exit-code`; do not use TypeScript lint rules as a
  substitute for `.proto` validation.
- Never edit any `package.json` manually with an editor or patch. Use Bun's
  package-management commands instead: `bun add`, `bun remove`,
  `bun pm pkg set`, or `bun pm pkg delete`. Run the command from the owning
  workspace, then review the resulting manifest and `bun.lock` diff. A
  dependency change is incomplete unless the lockfile is updated and the
  relevant check passes.
- Do not hand-edit `bun.lock`; regenerate it through Bun after changing a
  package manifest.
- Do not introduce Next.js. The accepted Web/backend direction is TanStack Start with Bun 1.4 as the business-control runtime.
- Bun-specific runtime and compatibility guidance lives in
  `.agents/skills/using-bun-runtime/SKILL.md`; load it before changing Bun
  runtime code or dependencies. The target runtime remains Bun, never Node.

## Shared agent skills

- Project skills live in `.agents/skills`; `skills-lock.json` records their upstream source and content hash.
- Read and apply `tdd` for behavioral implementation and `codebase-design` when choosing or changing a test seam.
- Use `domain-modeling` when changing canonical domain terms or relationships; do not turn `CONTEXT.md` into a running specification.
- Use `code-review` from an independent context with an explicit fixed point. The coordinator must include this instruction in every Standards and Spec reviewer brief: perform the assigned review directly; do not invoke `code-review` again or spawn additional reviewers.
- Use `coforge-release` when inspecting or executing a cloud test deployment, publishing a local Computer installation candidate assembled from the `coforge-computer` and `coforge-daemon` packages, preparing or executing an exact-artifact production promotion, verifying release evidence, or rolling back. [`docs/release.md`](docs/release.md) is the canonical release contract; the Skill is only its execution layer.
- The engineering skills do not yet have an approved issue-tracker configuration. Until `docs/agents/issue-tracker.md` exists, give `code-review` an explicit spec source; if none is available, ask the requester instead of invoking an unavailable setup skill or inferring a tracker workflow.

## Architecture invariants

- The local product has exactly two packageable components: `packages/computer` and `packages/daemon`; the Computer package depends on the Daemon package for build and distribution.
- Users install only the Computer distribution. It must include the compatible Daemon payload; Daemon is not a second user-installed product or a public CLI entry point.
- Never create another local product component. Daemon runtime supervision is implemented and released inside `coforge-daemon`.
- `coforge-computer` and `coforge-daemon` are independent OS processes. Their local control channel is a Unix domain socket, not a TCP management port.
- One coforge-daemon owns one persisted daemon configuration and one cloud Workspace connection.
- `coforge-computer` does not maintain a long-lived cloud WebSocket. The daemon owns exactly one long-lived WSS connection for its configured Workspace.
- Server→Daemon delivery/control uses versioned CoForge RPC over the daemon WSS. Agent→Web message read/send uses the separately authorized HTTPS RPC and retries a stable `request_id`; OAuth, installation, and release metadata are the other HTTPS exceptions. Do not add unrelated Computer/Daemon REST business endpoints.
- Daemon runtimes adapt Codex, Claude Code, Pi, and other code-agent runtimes through provider-neutral code-agent adapters. Each adapter may use an officially supported native protocol, SDK child runner, or ACP; higher layers must not parse provider-specific output.
- Caddy owns public TLS and edge proxying. Standalone Centrifugo OSS owns WSS/RPC transport mechanics only. Web/backend owns authentication, conversations, persistence, and routing decisions.
- PostgreSQL is accessed through Web/backend. Centrifugo must not acquire domain or database ownership.
- Redis is Centrifugo broker/presence/hot-history state plus Web message-request idempotency state. PostgreSQL canonical Message/read state is the message recovery boundary; any daemon status spool does not make Agent Activity reliable.
- Agent Activity is best-effort observation over the dedicated `activity:<workspace_id>` Centrifugo namespace. Daemon does not wait, retry, spool, or require an application ACK; publish-proxy authorization must validate the trusted connection scope before allowing the publication.
- Do not reintroduce the removed custom Go realtime-gateway, add Fiber, or embed Centrifuge as a production path.
- The current MVP has no local durable message inbox/outbox and no complete per-Agent delivery ledger. ACK only after `CodeAgentSession`/`notify` successfully accepts the attention; ACK does not mean the Agent run finished.
- Recover lost volatile attention from cloud canonical Message/read boundaries. Agent→Web read/send uses the independent HTTPS RPC and retries the same `request_id`; do not route it through WSS.
- Do not introduce a database command mailbox, claim/lease workflow, or treat a connection-local WebSocket outbox as durable storage without a new recorded architecture decision.
- The MVP is message-centric private direct chat; group chat is not implemented yet. Do not make commands, generic jobs, workflows, or run/event persistence part of the core model without a recorded decision.

## Dependency and security rules

- Keep domain and protocol packages independent of UI frameworks, database clients, transport servers, and concrete Agent providers.
- Validate external input at process and network boundaries. Version shared protocols explicitly.
- Keep credentials out of source, logs, command arguments, fixtures, and generated artifacts.
- Restrict Agent processes to their declared Agent workspace directories and explicitly allowed environment variables.
