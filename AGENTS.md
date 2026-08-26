# CoForge repository instructions

These instructions apply to the entire repository.

## Read the architecture first

- Read [`docs/architecture.md`](docs/architecture.md) before changing package boundaries, process ownership, transport, delivery semantics, persistence, infrastructure, or runtime versions.
- Treat that document as the canonical architecture source. Update it in the same change whenever an architectural decision changes.
- Keep `docs/architecture.md` as the single maintained architecture source; do not create a duplicate HTML companion.
- Do not turn an unresolved question into a repository convention. Raise it in `#coforge` and record the decision before implementation.

## Collaboration and delivery

- During the validation phase, develop directly on `main`; do not create a long-lived `dev` branch.
- Multiple agents may work on `main` concurrently. Keep commits narrow, preserve unrelated changes, fetch and rebase onto the latest `origin/main` before pushing, and never force-push.
- Use concise English Conventional Commit messages: `<type>(optional-scope): imperative summary` (for example, `docs: refine delivery guarantees`).
- Use the repository owner's GitHub identity for commits: `me-frankan <me.frankan@gmail.com>`. Never commit with an Agent name or Agent email.
- Respect ownership claimed in `#coforge`. Coordinate before editing another agent's active files or changing a shared contract.
- A task is complete only after relevant formatting, type checking, tests, and build checks pass. If a check does not exist yet, state that clearly in the handoff.
- Develop behavioral changes with test-driven development. Agree the public test seam first, then work in vertical slices: one failing test followed by the minimum implementation that passes it.
- Start bug fixes with a regression test. Do not remove or weaken a valid test merely to make CI pass.
- Keep refactoring in the independent review stage rather than expanding a red-green implementation slice.

## Toolchain

- Use `mise` as the repository's development tool and version manager.
- Treat `mise.toml` as the source of truth for tool versions once present. Run `mise install`, then prefer `mise run <task>` or `mise exec -- <command>` over unpinned global tools.
- Run `mise run test`, `mise run check`, and `mise run build` before submitting a change; CI runs them in that order.
- Do not silently change a runtime or tool version. Update `mise.toml`, affected lockfiles, CI, and architecture documentation together.
- Do not introduce Next.js. The accepted Web/backend direction is TanStack Start on Node 24 LTS.

## Shared agent skills

- Project skills live in `.agents/skills`; `skills-lock.json` records their upstream source and content hash.
- Read and apply `tdd` for behavioral implementation and `codebase-design` when choosing or changing a test seam.
- Use `domain-modeling` when changing canonical domain terms or relationships; do not turn `CONTEXT.md` into a running specification.
- Use `code-review` from an independent context with an explicit fixed point. The coordinator must include this instruction in every Standards and Spec reviewer brief: perform the assigned review directly; do not invoke `code-review` again or spawn additional reviewers.
- The engineering skills do not yet have an approved issue-tracker configuration. Until `docs/agents/issue-tracker.md` exists, give `code-review` an explicit spec source; if none is available, ask the requester instead of invoking an unavailable setup skill or inferring a tracker workflow.

## Architecture invariants

- The local product has exactly two distributable app packages: `apps/coforge-computer` and `apps/coforge-daemon`.
- Never create `apps/workspace-daemon`. A workspace-daemon is a child-process role implemented and released inside `coforge-daemon`.
- `coforge-computer` and `coforge-daemon` are independent OS processes. Their local control channel is a Unix domain socket, not a TCP management port.
- One coforge-daemon manages zero or more workspace-daemon child processes; each workspace-daemon belongs to exactly one workspace.
- Workspace-daemons adapt Codex, Claude Code, Pi, and other code-agent runtimes through ACP. Higher layers must not parse provider-specific output.
- Caddy owns public TLS and edge proxying. The Go realtime-gateway owns WSS/RPC transport only. Web/backend owns authentication, conversations, persistence, and routing decisions.
- PostgreSQL is accessed through Web/backend. The realtime-gateway must not acquire domain or database ownership.
- Delivery is at-least-once and idempotent: a canonical message plus per-Agent delivery ledger is the durable model. An ACK means the local workspace-daemon accepted responsibility, not that an Agent run finished.
- Do not ACK a cloud delivery until the workspace child has durably accepted local responsibility. Outbound Agent messages must also be locally retryable and server-idempotent across reconnects.
- Do not introduce a database command mailbox, claim/lease workflow, or treat a connection-local WebSocket outbox as durable storage without a new recorded architecture decision.
- The MVP is message-centric private/group chat. Do not make commands, generic jobs, workflows, or run/event persistence part of the core model without a recorded decision.

## Dependency and security rules

- Keep domain and protocol packages independent of UI frameworks, database clients, transport servers, and concrete Agent providers.
- Validate external input at process and network boundaries. Version shared protocols explicitly.
- Keep credentials out of source, logs, command arguments, fixtures, and generated artifacts.
- Restrict Agent processes to their declared Agent workspace directories and explicitly allowed environment variables.
