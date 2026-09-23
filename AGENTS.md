<!-- intent-skills:start -->
## Skill Loading

Before editing files for a substantial task:
- Run `bunx @tanstack/intent@latest list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `bunx @tanstack/intent@latest load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

# CoForge repository instructions

These instructions apply to the entire repository.

## Decisions

- Do not turn an unresolved question into code or a repository convention. Present the options and trade-offs in `#coforge`, then record the decision in the CR description before implementation; use Frank's approval only when the decision meets a gate below.
- This repository keeps no ADRs, no separate architecture document, and no implementation-slice notes. Do not create `docs/adr/`, `docs/architecture.md`, or similar decision logs, even when a skill suggests one. The architecture invariants below and the owning directory's `AGENTS.md` are the maintained rules.

## Documentation and agent instructions

- Put project documentation under `docs/`. The root `README.md` is the documentation index: every document under `docs/`, every `AGENTS.md`, and every package or directory `README.md` is linked from it with one line saying what it covers.
- Use progressive disclosure. A document is an overview plus links to smaller topic files; keep each Markdown file under 200 lines and split it into a directory of topic files before it grows past that.
- Keep each `AGENTS.md` under 200 lines. It holds rules an agent cannot infer from the code: commands, conventions, boundaries, and gotchas. Do not write function-by-function descriptions, implementation walkthroughs, change history, or "historical status" notes; the code, its comments, and its tests carry those.
- Place instructions next to the code they govern. A rule that applies only to one directory belongs in that directory's `AGENTS.md`, which agents load only when they work there. Put long, occasionally needed procedures in a skill under `.agents/skills/` with its details in linked reference files.
- A change that alters documented behavior, a rule, or a command updates the document that states it in the same CR. Delete statements that are no longer true instead of annotating them.

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
- Use the repository's logging framework directly. Configure its sinks and
  lifecycle once at the application entry point, and obtain category loggers
  through the framework in owning modules. Do not add a logger wrapper,
  adapter, facade, parallel low-level logger, or another abstraction layer over
  capabilities the logging framework already provides.
- Keep a module map in the owning app's `AGENTS.md`: one line per module
  naming its directory and single responsibility. Update it before
  reorganizing or adding a module. If the ownership or boundary is unclear,
  stop and settle the design options before writing implementation code.
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
- Do not add or broaden lint, formatting, type-check, or test exemptions without
  the user's explicit prior approval, including exemptions for official upstream
  components. This covers configuration overrides, ignore patterns, inline
  disable comments, and skipped checks. Fix the underlying code instead; an
  existing exemption is not permission to add another. When requesting approval,
  name the exact files, rules, reason, and verification being bypassed.

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
- Before adding, changing, or removing a mise task, read and follow
  [the mise task policy](docs/agents/mise-tasks.md).
- Keep mise as the small, stable repository command surface: add a task only
  for a documented developer entry point, reusable repository gate,
  cross-workspace or cross-tool orchestration, or behavior that needs mise task
  features. Keep package-owned commands in that workspace's `package.json`;
  never mirror every package script or add a CI-only forwarding task.
- Give each operation one implementation owner. Keep short task declarations
  in `mise.toml`, substantial procedural logic in checked executable scripts,
  and CI-provider concerns in workflow YAML.

- Do not silently change a runtime or tool version. Update `mise.toml`, affected lockfiles, and CI together.
- Protobuf schemas under `packages/coforge-sdk/proto` must pass `buf lint` and
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
- The repository keeps no separate glossary. Do not create `CONTEXT.md`, even when `domain-modeling` suggests one.
- Use `code-review` from an independent context with an explicit fixed point. The coordinator must include this instruction in every Standards and Spec reviewer brief: perform the assigned review directly; do not invoke `code-review` again or spawn additional reviewers.
- Use `coforge-release` when inspecting or executing a cloud test deployment, publishing a local Computer installation candidate assembled from the `coforge-computer` and `coforge-daemon` packages, preparing or executing an exact-artifact production promotion, verifying release evidence, or rolling back. [`docs/release/README.md`](docs/release/README.md) is the overview of the canonical release contract, with one topic file per concern under `docs/release/`; the Skill is only its execution layer.
- When comparing CoForge with Raft Computer, the reference is the shipped
  binary 1.0.32, not any npm release. Read
  [the Raft Computer 1.0.32 research guide](docs/agents/reference-cli-research.md)
  first; it records how to recover its source and what is already mapped.
- The engineering skills do not yet have an approved issue-tracker configuration. Until `docs/agents/issue-tracker.md` exists, give `code-review` an explicit spec source; if none is available, ask the requester instead of invoking an unavailable setup skill or inferring a tracker workflow.

## Architecture invariants

- The local product has exactly two source/package components: `packages/computer` and `packages/daemon`; the Computer package depends on the Daemon package at build time.
- Users install one native `coforge-computer` executable. That executable contains both package roles and dispatches internal `__daemon` and `__agent-cli` modes; Daemon is not a standalone release payload, user-installed product, or public CLI entry point.
- Never create another local product component. Daemon runtime supervision is implemented and released inside `coforge-daemon`.
- Computer and Daemon roles remain independent OS processes even though both execute the same native file. Their local control channel is a Unix domain socket, not a TCP management port.
- One coforge-daemon owns one persisted daemon configuration and one cloud Workspace connection.
- `coforge-computer` does not maintain a long-lived cloud WebSocket. The daemon owns exactly one long-lived WSS connection for its configured Workspace.
- Server→Daemon delivery/control uses versioned CoForge RPC over the daemon WSS. Agent→Web message read/send and the approved Agent Reminder management use the separately authorized HTTPS RPC with stable `request_id`; Computer setup/attach uses User-authenticated HTTPS RPC for `workspace:get` and `computer:register`, without a temporary WebSocket or WSS fallback. OAuth, installation, and release metadata are the other HTTPS exceptions. Reminder plan synchronization and due-time arbitration remain on WSS; its scoped pending-fire receipts are not a general Message inbox/outbox. Do not add unrelated Computer/Daemon REST business endpoints.
- Daemon runtimes adapt Codex, Claude Code, Pi, and other code-agent runtimes through provider-neutral code-agent adapters. Each adapter may use an officially supported native protocol, SDK child runner, or ACP; higher layers must not parse provider-specific output.
- Caddy owns public TLS and edge proxying. Standalone Centrifugo OSS owns WSS/RPC transport mechanics only. Web/backend owns authentication, conversations, persistence, and routing decisions.
- PostgreSQL is accessed through Web/backend. Centrifugo must not acquire domain or database ownership.
- Redis is Centrifugo broker/presence/hot-history state plus Web message-request idempotency state. PostgreSQL canonical Message/read state is the message recovery boundary; any daemon status spool does not make Agent Activity reliable.
- Agent Activity is best-effort observation over the dedicated `agent:activity:<workspace_id>` Centrifugo namespace, or, for a private Agent, the re-routed per-Agent `agent:activity:<workspace_id>:<agent_id>` (with a matching per-Agent `agent:status:<workspace_id>:<agent_id>` for `agent:display`) — Daemon always publishes to the shared namespace unchanged; the Web publish proxy picks the destination from the Agent's current visibility. Daemon does not wait, retry, spool, or require an application ACK; publish-proxy authorization must validate the trusted connection scope before allowing the publication.
- Do not reintroduce the removed custom Go realtime-gateway, add Fiber, or embed Centrifuge as a production path.
- The current MVP has no local durable message inbox/outbox and no complete per-Agent delivery ledger. ACK only after `CodeAgentSession`/`notify` successfully accepts the attention; ACK does not mean the Agent run finished.
- Recover lost volatile attention from cloud canonical Message/read boundaries. Agent→Web read/send uses the independent HTTPS RPC and retries the same `request_id`; do not route it through WSS.
- Do not introduce a database command mailbox, claim/lease workflow, or treat a connection-local WebSocket outbox as durable storage without Frank's approval.
- The MVP supports private User–Agent direct chat and Workspace-visible public channels. Channel notifications follow per-Agent mute settings, with human personal mentions overriding mute; Agent-originated messages never automatically wake Agents. Do not make commands, generic jobs, workflows, or run/event persistence part of the core model without Frank's approval.

## Dependency and security rules

- Keep domain and protocol packages independent of UI frameworks, database clients, transport servers, and concrete Agent providers.
- Validate external input at process and network boundaries. Version shared protocols explicitly.
- Keep credentials out of source, logs, command arguments, fixtures, and generated artifacts.
- Launch Agent processes in their declared Agent workspace directories. Inherit the Daemon's ordinary local environment, then apply explicit Agent overrides, adapter extraEnv, and trusted CoForge launch fields. Never upload inherited environment variables; cloud persistence is only for user-entered overrides. Clear stale CoForge Agent capabilities and control sockets before installing the current launch fields.
