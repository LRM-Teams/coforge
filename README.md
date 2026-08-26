# Coforge

Coforge is a private and group chat product for working with code agents that
run inside local workspaces. The cloud owns conversations and durable message
delivery; local workspace processes connect outbound and adapt agent runtimes
through the Agent Client Protocol (ACP).

The project is in its architecture-validation phase.

## Architecture

```text
Browser -> Caddy -> TanStack Start web/backend -> PostgreSQL
              \--> standalone Centrifugo <-WSS- workspace child
                          |      ^
                       Redis    | HTTP/gRPC proxy + server API
                                +---- Bun backend

coforge-computer <-Unix socket-> coforge-daemon -> N workspace children -> ACP
```

- Web/backend: TanStack Start on Node 24 LTS
- Realtime transport: standalone Centrifugo OSS over WebSocket
- Realtime hot state: self-hosted Redis Docker; never canonical durability
- Canonical cloud state: self-hosted PostgreSQL Docker with backup/restore gates
- Local apps: Bun 1.4
- Edge and local deployment: Caddy and Docker
- Development tool versions: mise

Only `coforge-computer` and `coforge-daemon` are local app packages. The
Computer package depends on the Daemon package for build and distribution, so
users install one Computer distribution containing both compatible payloads.
Computer and Daemon still run as independent OS processes. A workspace child
is an isolated process implemented inside `coforge-daemon`, not a third package.

See [the architecture baseline](docs/architecture.md) for the canonical
boundaries and [the database design](docs/database-schema.md) for the current
conversation and delivery model. See [the release contract](docs/release.md)
for cloud deployment, atomic Computer installation bundles and compatibility
release sets, exact-artifact production promotion, per-user installation, and
rollback rules. The accepted realtime and MVP data-service decision is recorded
in [ADR 0001](docs/adr/0001-standalone-centrifugo-and-compose-data-services.md).

## Repository layout

```text
apps/realtime-gateway   Obsolete Go skeleton pending removal; not a production path
apps/web                Web UI and backend control plane (scaffold pending)
apps/coforge-computer   Machine-level setup and supervisor
apps/coforge-daemon     Workspace process manager (scaffold pending)
database                PostgreSQL migrations
docs                    Architecture, ADRs, and data-model documentation
packages                Shared protocol and ACP adapters (pending ADRs)
```

## Development

Install the pinned toolchain and dependencies:

```bash
mise install
mise run install
```

Run tests first, then repository checks and production builds:

```bash
mise run test
mise run check
mise run build
```

GitHub Actions currently keeps separate Computer and legacy realtime-gateway
jobs for every pull request and every push to `main`, so failures stay
attributable during the removal transition. Dependency installation uses
frozen-lockfile mode. Runtime versions continue to come from `mise.toml`.

The current realtime-gateway command exists only to keep the obsolete skeleton
green until its focused removal change:

```bash
mise exec -- bun run dev:gateway
```

Do not add production behavior or dependencies to that skeleton. Standalone
Centrifugo, Redis, PostgreSQL, Backend proxy/API wiring, and their Compose
configuration land only in separately approved focused changes.

## Development workflow

Create each change on a short-lived feature branch and merge it into `main` only
through an approved CR/PR. Direct pushes to `main` are not allowed. Keep CRs
narrow, use English Conventional Commit messages, rebase the latest
`origin/main`, and run the short relevant checks before requesting review.
During MVP, ordinary changes use one Agent review and target a 5–10 minute
review-to-merge cycle; only broad or difficult-to-reverse decisions require
Frank's explicit approval.

Use test-driven development for behavioral changes: agree the public test seam,
then work one vertical slice at a time with a failing test followed by the
smallest passing implementation. Refactoring belongs to independent review.
Read [AGENTS.md](AGENTS.md) for the normative decision gates, review
requirements, and architecture-change rules.

Project-level engineering and release skills are maintained under
`.agents/skills`. Upstream engineering skills are pinned by `skills-lock.json`;
the repository-owned `coforge-release` Skill points to `docs/release.md` as its
canonical contract. They are shared by supported coding agents when working in
this repository.
