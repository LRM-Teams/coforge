# CoForge repository instructions

These instructions apply to the entire repository.

## Read the architecture first

- Read [`docs/architecture.md`](docs/architecture.md) before changing package boundaries, process ownership, transport, delivery semantics, persistence, infrastructure, or runtime versions.
- Treat that document as the canonical architecture source. Update it in the same change whenever an architectural decision changes.
- Keep `docs/architecture.md` as the single maintained architecture source; do not create a duplicate HTML companion.
- Do not turn an unresolved question into code or a repository convention. Present the options and trade-offs in `#coforge`, then record the decision before implementation; use Frank's approval only when the decision meets a gate below.

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

## Toolchain

- Use `mise` as the repository's development tool and version manager.
- Treat `mise.toml` as the source of truth for tool versions once present. Run `mise install`, then prefer `mise run <task>` or `mise exec -- <command>` over unpinned global tools.
- Run `mise run test`, `mise run check`, and `mise run build` before submitting a change; CI runs them in that order.
- Do not silently change a runtime or tool version. Update `mise.toml`, affected lockfiles, CI, and architecture documentation together.
- Do not introduce Next.js. The accepted Web/backend direction is TanStack Start with Bun 1.4 as the business-control runtime.

## Shared agent skills

- Project skills live in `.agents/skills`; `skills-lock.json` records their upstream source and content hash.
- Read and apply `tdd` for behavioral implementation and `codebase-design` when choosing or changing a test seam.
- Use `domain-modeling` when changing canonical domain terms or relationships; do not turn `CONTEXT.md` into a running specification.
- Use `code-review` from an independent context with an explicit fixed point. The coordinator must include this instruction in every Standards and Spec reviewer brief: perform the assigned review directly; do not invoke `code-review` again or spawn additional reviewers.
- Use `coforge-release` when inspecting or executing a cloud test deployment, publishing a local Computer installation candidate assembled from the `coforge-computer` and `coforge-daemon` packages, preparing or executing an exact-artifact production promotion, verifying release evidence, or rolling back. [`docs/release.md`](docs/release.md) is the canonical release contract; the Skill is only its execution layer.
- The engineering skills do not yet have an approved issue-tracker configuration. Until `docs/agents/issue-tracker.md` exists, give `code-review` an explicit spec source; if none is available, ask the requester instead of invoking an unavailable setup skill or inferring a tracker workflow.

## Architecture invariants

- The local product has exactly two app packages: `apps/coforge-computer` and `apps/coforge-daemon`; the Computer package depends on the Daemon package for build and distribution.
- Users install only the Computer distribution. It must include the compatible Daemon payload; Daemon is not a second user-installed product or a public CLI entry point.
- Never create `apps/workspace-daemon`. A workspace-daemon is a child-process role implemented and released inside `coforge-daemon`.
- `coforge-computer` and `coforge-daemon` are independent OS processes. Their local control channel is a Unix domain socket, not a TCP management port.
- One coforge-daemon manages zero or more workspace-daemon child processes; each workspace-daemon belongs to exactly one workspace.
- Workspace-daemons adapt Codex, Claude Code, Pi, and other code-agent runtimes through ACP. Higher layers must not parse provider-specific output.
- Caddy owns public TLS and edge proxying. Standalone Centrifugo OSS owns WSS/RPC transport mechanics only. Web/backend owns authentication, conversations, persistence, and routing decisions.
- PostgreSQL is accessed through Web/backend. Centrifugo must not acquire domain or database ownership.
- Redis is Centrifugo broker/presence/hot-history state only. PostgreSQL plus each workspace-daemon's durable spool remain the canonical durability and replay boundary.
- Do not extend the obsolete custom Go realtime-gateway, add Fiber, or embed Centrifuge as a production path. Its existing skeleton remains only until the approved follow-up removes source, commands, and CI.
- Delivery is at-least-once and idempotent: a canonical message plus per-Agent delivery ledger is the durable model. An ACK means the local workspace-daemon accepted responsibility, not that an Agent run finished.
- Do not ACK a cloud delivery until the workspace child has durably accepted local responsibility. Outbound Agent messages must also be locally retryable and server-idempotent across reconnects.
- Do not introduce a database command mailbox, claim/lease workflow, or treat a connection-local WebSocket outbox as durable storage without a new recorded architecture decision.
- The MVP is message-centric private/group chat. Do not make commands, generic jobs, workflows, or run/event persistence part of the core model without a recorded decision.

## Dependency and security rules

- Keep domain and protocol packages independent of UI frameworks, database clients, transport servers, and concrete Agent providers.
- Validate external input at process and network boundaries. Version shared protocols explicitly.
- Keep credentials out of source, logs, command arguments, fixtures, and generated artifacts.
- Restrict Agent processes to their declared Agent workspace directories and explicitly allowed environment variables.
