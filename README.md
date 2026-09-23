# Coforge

Coforge is a private and group chat product for working with code agents that
run inside local workspaces. The cloud owns conversations and durable message
delivery; local workspace processes connect outbound and adapt resident agent
runtimes through provider-neutral code-agent adapters.

## Architecture

```text
Browser -> Caddy -> TanStack Start / Bun backend -> PostgreSQL
              \--> standalone Centrifugo <-one WSS- coforge-daemon
                          |      |
                       Redis    | HTTP/gRPC proxy + server API
                                +---- backend

coforge-computer <-Unix socket-> coforge-daemon -> N Agent runtime OS children
```

- Web/backend: TanStack Start with Bun 1.4; PostgreSQL through Prisma
- Realtime transport: standalone Centrifugo OSS over WebSocket, Redis for hot state
- Local product: one `coforge-computer` executable containing the Computer and
  Daemon roles, which run as separate OS processes
- Edge and deployment: Caddy and Docker; tool versions pinned by mise

The architecture invariants every change must respect are in
[AGENTS.md](AGENTS.md#architecture-invariants).

## Documentation

| Document | Covers |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Repository rules: decisions, module design, delivery, toolchain, architecture invariants |
| [apps/web/AGENTS.md](apps/web/AGENTS.md) | Web/backend rules and module map |
| [packages/computer/AGENTS.md](packages/computer/AGENTS.md) | Computer package rules and module map |
| [packages/daemon/AGENTS.md](packages/daemon/AGENTS.md) | Daemon package rules and module map |
| [docs/database-schema/](docs/database-schema/README.md) | Database schema and conversation/delivery model |
| [docs/reliable-message-delivery.md](docs/reliable-message-delivery.md) | Message delivery guarantees |
| [docs/observability/](docs/observability/README.md) | Agent Activity, status, and observability baseline |
| [docs/local-logging.md](docs/local-logging.md) | Computer/Daemon logging contract |
| [docs/release/](docs/release/README.md) | Release contract: deployment, Computer distribution, promotion, rollback |
| [docs/design/](docs/design/README.md) | Product UI design guidance |
| [docs/design-tokens.md](docs/design-tokens.md) | Design tokens |
| [docs/operations/aliyun-oss-cdn/](docs/operations/aliyun-oss-cdn/README.md) | OSS/CDN provisioning runbook |
| [docs/operations/cdn-certificates/](docs/operations/cdn-certificates/README.md) | CDN certificate renewal runbook |
| [docs/agents/testing.md](docs/agents/testing.md) | Testing guidance for agents |
| [docs/agents/e2e-testing/](docs/agents/e2e-testing/README.md) | Live OpenRouter integration test |
| [docs/agents/mise-tasks.md](docs/agents/mise-tasks.md) | Mise task policy |
| [docs/agents/reference-cli-research.md](docs/agents/reference-cli-research.md) | Studying the Raft Computer 1.0.32 reference |
| [apps/web/README.md](apps/web/README.md) | Web app setup and scripts |
| [apps/web/src/components/ui/README.md](apps/web/src/components/ui/README.md) | UI component inventory and exceptions |
| [packages/computer/README.md](packages/computer/README.md) | `coforge-computer` package |
| [packages/daemon/README.md](packages/daemon/README.md) | `coforge-daemon` package |
| [packages/agent/README.md](packages/agent/README.md) | Built-in Pi-based Agent runtime |
| [packages/coforge/README.md](packages/coforge/README.md) | Agent-facing `coforge` CLI |
| [docs/agent-cli/](docs/agent-cli/README.md) | `coforge` Agent CLI command reference |
| [packages/coforge-sdk/README.md](packages/coforge-sdk/README.md) | Shared contracts and transports |
| [infra/README.md](infra/README.md) | Local Docker Compose services |
| [docs/operations/staging/](docs/operations/staging/README.md) | Staging environment runbook |

Project skills live in `.agents/skills`; `skills-lock.json` pins the upstream ones.

## Repository layout

```text
apps/web                Web UI and backend control plane
packages/computer       Machine-level setup and supervisor package component
packages/daemon         Single-workspace daemon and code-agent adapter package component
packages/agent          Independently packable built-in Agent runtime using Pi SDK
packages/coforge        Agent CLI
packages/coforge-sdk    Shared protocol and Agent SDK
docs                    Project documentation
infra                   Local and staging deployment
```

## Development

Install the pinned toolchain and dependencies:

```bash
mise install
mise run setup
```

Run tests first, then repository checks and production builds:

```bash
mise run test
mise run check
mise run build
```

Every change goes through a short-lived branch and an approved PR; see
[AGENTS.md](AGENTS.md#collaboration-and-delivery).
