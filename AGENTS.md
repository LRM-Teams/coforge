# CoForge repository instructions

These instructions apply to the entire repository.

## Read the architecture first

- Read [`docs/architecture.md`](docs/architecture.md) before changing package boundaries, process ownership, transport, delivery semantics, persistence, infrastructure, or runtime versions.
- Treat that document as the canonical architecture source. Update it in the same change whenever an architectural decision changes.
- `docs/architecture.html` is the human-readable companion. Keep it consistent with the canonical Markdown document when architecture changes.
- Do not turn an unresolved question into code or a repository convention. Present the options and trade-offs in `#coforge`, then wait for Frank's explicit approval before implementation.

## Decision gates

- Obtain explicit approval before selecting or adding a framework, ORM, database schema, SQL migration, wire protocol, license, or lint stack. Do not prewrite an unapproved choice as code, configuration, or generated output.
- Prefer a mature maintained framework when it satisfies the requirements. Propose custom infrastructure only after documenting the gap, maintenance burden, and alternatives.
- Base technical proposals and implementations on current official documentation, official repositories, and official migration guides. Do not rely on remembered or built-in knowledge for versions, APIs, configuration, or support status.
- For each technical proposal, cite its official sources and state the problem, candidates, maturity, license, runtime compatibility, operational cost, migration/rollback impact, recommendation, and unresolved risks. Mark experimental or undocumented behavior explicitly and do not implement it without approval.
- CoForge is source-closed and grants no commercial-use rights unless Frank approves a different license. Do not add an open-source license or assume a third-party license policy without review.
- Establish formatting and lint checks before feature implementation, and make them required CR checks once the tool selection is approved.

## Collaboration and delivery

- Follow the lightweight, branch-based [GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow). Create every change on a short-lived feature branch from the latest `origin/main`; use a clear prefix such as `feat/`, `fix/`, `docs/`, or `chore/`. Do not use a long-lived `dev` branch.
- Keep MVP branches to one small objective and, as a rule, merge or close them within the same working day. Prefer a sequence of small CRs to a multi-day feature branch.
- Never commit or push directly to `main`. A change reaches `main` only through a CR/PR with passing required checks and at least one approval from a reviewing Agent or human. Authors must not self-approve their own CR.
- Use the MVP fast lane for ordinary implementation and documentation: one Agent review, the short automated checks, and immediate squash/rebase merge once feedback is resolved. Target a 5–10 minute review-to-merge cycle; Frank does not need to approve each ordinary CR.
- Frank's explicit approval remains required for the decision gates above and for changes to architecture, database schema, wire protocol, licensing, security boundaries, or other decisions with broad or difficult-to-reverse impact.
- Keep each branch and CR focused on one concern. Preserve unrelated work and coordinate in `#coforge` before touching files another contributor has claimed.
- Before requesting final review, fetch and rebase the branch onto the latest `origin/main`. Never force-push `main` or another contributor's branch.
- Use concise English Conventional Commit messages: `<type>(optional-scope): imperative summary` (for example, `docs: refine delivery guarantees`).
- Use the repository owner's GitHub identity for commits: `me-frankan <me.frankan@gmail.com>`. Never commit with an Agent name or Agent email.
- Amend or rebase mistakes on the feature branch before review. Do not add revert commits merely to clean up work that has not been merged.
- Keep `main` history clean and linear by using the repository's approved squash/rebase merge strategy, then delete the merged branch; do not create gratuitous merge commits.
- A CR must describe its scope, approved decisions, official source links for technical choices, tests and checks run, known risks, and any follow-up work. Do not merge while review comments remain unresolved.
- During MVP, keep required CI short: formatting/linting, type checking, relevant tests, and build. Add slower checks only when their risk reduction justifies the feedback delay. GitHub documents reviews and status checks as independently configurable [branch protection options](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
- A task is complete only after the relevant short checks pass and the CR is approved. If a check does not exist yet, state that clearly in the CR.

## Toolchain

- Use `mise` as the repository's development tool and version manager.
- Treat `mise.toml` as the source of truth for tool versions once present. Run `mise install`, then prefer `mise run <task>` or `mise exec -- <command>` over unpinned global tools.
- Do not silently change a runtime or tool version. Update `mise.toml`, affected lockfiles, CI, and architecture documentation together.
- Do not introduce Next.js. The accepted Web/backend direction is TanStack Start on Node 24 LTS.

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
- Restrict Agent processes to their declared workspace roots and explicitly allowed environment variables.
