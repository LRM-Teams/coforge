# Coforge

Coforge is a private and group chat product for working with code agents that
run inside local workspaces. The cloud owns conversations and durable message
delivery; local workspace processes connect outbound and adapt resident agent
runtimes through provider-neutral code-agent adapters.

The project is in its architecture-validation phase.

## Architecture

```text
Browser -> Caddy -> TanStack Start / Bun backend -> PostgreSQL
              \--> standalone Centrifugo <-one WSS- coforge-daemon
                          |      |
                       Redis    | HTTP/gRPC proxy + server API
                                +---- backend

coforge-computer <-Unix socket-> coforge-daemon -> N Agent runtime OS children

Runtime inventory metadata uses `provider + kind` as the runtime identity (for
example, `pi:builtin` and `pi:external` may coexist on one Computer). Runtime
configuration can reference this identity later; the current MVP does not
provide UI runtime selection or add a protocol command for it.
```

- Web/backend: TanStack Start with Bun 1.4 as the business-control runtime
- Realtime transport: standalone Centrifugo OSS over WebSocket
- Realtime hot state: self-hosted Redis Docker; never canonical durability
- Canonical cloud state: self-hosted PostgreSQL Docker with backup/restore gates
- Local apps: Bun 1.4
- Edge and local deployment: Caddy and Docker
- Development tool versions: mise

Only `coforge-computer` and `coforge-daemon` are local app packages. The
Computer package depends on the Daemon package for build and distribution, so
users install one Computer distribution containing both compatible payloads.
Computer and Daemon still run as independent OS processes. The daemon owns one
Workspace connection and directly manages Agent runtime child processes; there
is no WorkspaceWorker layer or Computer-to-Agent operation.
The independently packable `@coforge/agent` runtime package uses the Pi SDK and
is installed as an exact Daemon dependency; it is not a user installation
entry point.

See [the architecture baseline](docs/architecture.md) for the canonical
boundaries and [the database design](docs/database-schema.md) for the current
conversation and delivery model. See [the release contract](docs/release.md)
for cloud deployment, atomic Computer installation bundles and compatibility
release sets, exact-artifact production promotion, per-user installation, and
rollback rules. The accepted realtime and MVP data-service decision is recorded
in [ADR 0001](docs/adr/0001-standalone-centrifugo-and-compose-data-services.md).
PostgreSQL data access is standardized on Prisma; see [ADR 0003](docs/adr/0003-prisma-as-postgresql-data-access.md)
and the [Web/backend agent instructions](apps/web/AGENTS.md).
Computer and Daemon share the single LogTape-based contract documented in
[local application logging](docs/local-logging.md); implementation is pending.

## Repository layout

```text
apps/web                Web UI and backend control plane
apps/web/prisma         Planned Prisma schema and migrations
apps/coforge-computer   Machine-level setup and supervisor
apps/coforge-daemon     Single-workspace daemon and code-agent adapters
packages/agent          Independently packable built-in Agent runtime using Pi SDK
docs                    Architecture, ADRs, and data-model documentation
packages                Shared and independently packable runtime packages
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

GitHub Actions runs the focused infrastructure and Computer checks for every
pull request and every push to `main`. Dependency installation uses
frozen-lockfile mode. Runtime versions continue to come from `mise.toml`.

Standalone Centrifugo and Redis now have a local Docker Compose deployment in
[`infra/README.md`](infra/README.md). PostgreSQL and Backend proxy/API wiring
remain separate implementation slices.

Computer has exactly one active Workspace binding. Setup receives one external
Workspace setup intent; Computer never lists or selects Workspaces. Switching
stops the old daemon runtime/WSS/Agents, replaces only the active config, and
retains old local data, credentials, and Agent directories.

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
