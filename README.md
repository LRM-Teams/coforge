# Coforge

Coforge is a private and group chat product for working with code agents that
run inside local workspaces. The cloud owns conversations and durable message
delivery; local workspace processes connect outbound and adapt agent runtimes
through the Agent Client Protocol (ACP).

The project is in its architecture-validation phase.

## Architecture

```text
Browser -> Caddy -> TanStack Start web/backend -> PostgreSQL
              \--> Go realtime-gateway <-WSS- workspace child

coforge-computer <-Unix socket-> coforge-daemon -> N workspace children -> ACP
```

- Web/backend: TanStack Start on Node 24 LTS
- Realtime transport: Go 1.26.7 and WebSocket
- Local apps: Bun 1.4
- Edge and local deployment: Caddy and Docker
- Development tool versions: mise

Only `coforge-computer` and `coforge-daemon` are local distributable app
packages. A workspace child is an isolated process implemented inside
`coforge-daemon`, not a third package.

See [the architecture baseline](docs/architecture.md) for the canonical
boundaries and [the database design](docs/database-schema.md) for the current
conversation and delivery model.

## Repository layout

```text
apps/realtime-gateway   WSS transport and connection lifecycle
apps/web                Web UI and backend control plane (scaffold pending)
apps/coforge-computer   Machine-level supervisor (scaffold pending)
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

GitHub Actions runs the same sequence for every pull request and every push to
`main`. Dependency installation uses frozen-lockfile mode, so the first change
that adds a Bun dependency must also commit its generated lockfile. Runtime
versions continue to come from `mise.toml`.

Run the current realtime-gateway skeleton:

```bash
mise exec -- bun run dev:gateway
```

It exposes `GET /healthz`, `GET /readyz`, and `GET /v1/connect` on port 8080
by default. Set `PORT` and `DRAIN_TIMEOUT_MS` to override the development
defaults.

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

Project-level `tdd`, `codebase-design`, `domain-modeling`, and `code-review`
skills are maintained under `.agents/skills` and pinned by `skills-lock.json`.
They are shared by supported coding agents when working in this repository.
