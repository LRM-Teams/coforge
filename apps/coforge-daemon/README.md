# coforge-daemon

Status: runtime model accepted; implementation in progress

`coforge-daemon` is the machine-local process manager for logical CoForge
Workspaces. It is an independent distributable process managed by
`coforge-computer`.

## Runtime model

```text
coforge-computer (stable machine_id)
└── coforge-daemon
    ├── resident workspace worker for Workspace A
    │   ├── Agent A1 → Agent workspace directory A1
    │   └── Agent A2 → Agent workspace directory A2
    └── resident workspace worker for Workspace B
        └── Agent B1 → Agent workspace directory B1
```

`workspace worker` is a supervised child-process role inside this package. It is not a
third app or independently published package.

For every logical Workspace assigned to this Computer, `coforge-daemon` keeps
one resident workspace worker. Resident means that the worker stays
alive between messages while the Workspace remains assigned. A crashed or
replaced worker is a new process for the same stable `workspace_id`; it is not a
new Workspace.

## Vocabulary

| Term | Meaning |
| --- | --- |
| `machine_id` | The stable identity of the machine. It survives Computer, daemon, and child-process restarts and upgrades. |
| Workspace | The logical collaboration, membership, permission, conversation, and Agent boundary. |
| `workspace_id` | The stable end-to-end identity of that logical Workspace. |
| workspace connection | The assignment that makes a logical Workspace active on a Computer. |
| workspace worker | The daemon-supervised resident child process that represents one logical Workspace on the bound Computer. |
| Agent runtime process | A provider execution process, owned by one workspace worker and reused across prompts until its session is disposed. |
| Agent workspace | One Agent's durable filesystem working area on this Computer. It is not another logical Workspace. |

Documentation must qualify whether "workspace" means the logical Workspace or
an Agent workspace directory. Agent workspaces use the canonical relative path
`workspaces/<workspace_id>/agents/<agent_id>` and remain stable across runtime
replacement and provider changes.

## Ownership

`coforge-daemon` owns:

- convergence between the desired and actual set of resident workspace workers;
- spawning, monitoring, backoff, replacement, and orderly shutdown of those
  workers;
- one shared `AgentRuntimePool` for machine-level Agent capacity across all
  workspace workers, plus version compatibility for child processes.

Each workspace worker owns one `AgentProcessManager`. It requests capacity from
the daemon-owned `AgentRuntimePool` before starting an Agent runtime and returns
that capacity when the runtime stops. Workspace workers do not create their own
capacity pools.

Agent status has only two values: `online` while the Agent runtime process is
held by `AgentProcessManager`, and `offline` after the process exits or is
stopped. The status is derived from the local process lifecycle; starting,
stopping, errors, and work progress belong in the activity timeline instead.

`coforge-daemon` uses the machine's stable `machine_id`; it does not mint a new
machine identity for itself or for each workspace worker. The exact issuance,
persistence, uniqueness, and cloud database schema for `machine_id` are outside
this package model and require their own reviewed design.

Cloud-visible Computer online status is a realtime projection of workspace
worker connections: a Computer is online when at least one workspace worker's
WSS session is connected. The daemon package does not
persist an `online` flag or `last_seen_at` value as durable truth.

Each workspace worker owns, for exactly one logical Workspace:

- its outbound WSS session and protocol scope;
- its durable delivery inbox/outbox and replay cursor;
- the Agent runtimes in that Workspace through provider-neutral code-agent
  adapters;
- enforcement that each Agent can access only its declared Agent workspace
  directory and allowed environment.

A workspace worker may manage multiple Agents. It must never manage an Agent
from a different `workspace_id`.

A Computer may have zero or more code-agent runtimes installed. Having no
runtime installed is a valid machine state and must not prevent Computer or
daemon startup; Agent execution remains unavailable until a suitable runtime
is installed and configured.

## Non-responsibilities

- `coforge-daemon` does not install or upgrade the machine-level product;
  `coforge-computer` owns that lifecycle.
- Neither daemon owns cloud authentication, conversation persistence, or
  routing decisions.
- Provider-specific Codex, Claude Code, Pi, or other command and event formats
  stay behind code-agent adapters. The independently packaged `@coforge/agent`
  uses the Pi SDK and runs as a resident child process. Codex and Claude Code
  adapters start the user's existing `codex` and `claude` installations from
  `PATH`, preserving their login, settings, and skills rather than bundling
  provider SDKs or binaries. CoForge-assigned skills are materialized in each
  Agent workspace using the provider's project convention (`.pi/skills`,
  `.agents/skills`, or `.claude/skills`); user-global provider skills remain
  provider-owned. All three load Agent workspace skills before session startup
  completes; see ADR 0002.
- The workspace worker role must not become a third app package.

See [`../../docs/architecture.md`](../../docs/architecture.md) for the
canonical system architecture and [`../../docs/local-logging.md`](../../docs/local-logging.md)
for the local categorized, rotating log contract that must precede daemon lifecycle implementation.
