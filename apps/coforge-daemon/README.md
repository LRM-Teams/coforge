# coforge-daemon

Status: runtime model accepted; implementation pending

`coforge-daemon` is the machine-local process manager for logical CoForge
Workspaces. It is an independent distributable process managed by
`coforge-computer`.

## Runtime model

```text
coforge-computer (stable machine_id)
└── coforge-daemon
    ├── resident workspace-daemon for Workspace A
    │   ├── Agent A1 → Agent workspace directory A1
    │   └── Agent A2 → Agent workspace directory A2
    └── resident workspace-daemon for Workspace B
        └── Agent B1 → Agent workspace directory B1
```

`workspace-daemon` is a child-process role inside this package. It is not a
third app or independently published package.

For every logical Workspace assigned to this Computer, `coforge-daemon` keeps
one resident `workspace-daemon` child. Resident means that the child stays
alive between messages while the Workspace remains assigned. A crashed or
replaced child is a new process for the same stable `workspace_id`; it is not a
new Workspace.

## Vocabulary

| Term | Meaning |
| --- | --- |
| `machine_id` | The stable identity of the machine. It survives Computer, daemon, and child-process restarts and upgrades. |
| Workspace | The logical collaboration, membership, permission, conversation, and Agent boundary. |
| `workspace_id` | The stable end-to-end identity of that logical Workspace. |
| workspace binding | The assignment that makes a logical Workspace active on a Computer. |
| workspace-daemon | The resident child process that represents one logical Workspace on the bound Computer. |
| Agent workspace | One Agent's filesystem working area. It is not another logical Workspace. |

Documentation must qualify whether "workspace" means the logical Workspace or
an Agent workspace directory. The exact code and protocol field name for the
directory remains a separate decision before implementation.

## Ownership

`coforge-daemon` owns:

- convergence between the desired and actual set of resident Workspace
  children;
- spawning, monitoring, backoff, replacement, and orderly shutdown of those
  children;
- resource governance and version compatibility for child processes.

`coforge-daemon` uses the machine's stable `machine_id`; it does not mint a new
machine identity for itself or for each Workspace child. The exact issuance,
persistence, uniqueness, and cloud database schema for `machine_id` are outside
this package model and require their own reviewed design.

Cloud-visible Computer online status is a realtime projection of Workspace
child connections: a Computer is online when at least one of its
`workspace-daemon` WSS sessions is connected. The daemon package does not
persist an `online` flag or `last_seen_at` value as durable truth.

Each `workspace-daemon` owns, for exactly one logical Workspace:

- its outbound WSS session and protocol scope;
- its durable delivery inbox/outbox and replay cursor;
- the Agent runtimes in that Workspace through ACP adapters;
- enforcement that each Agent can access only its declared Agent workspace
  directory and allowed environment.

A Workspace child may manage multiple Agents. It must never manage an Agent
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
- Provider-specific Codex, Claude Code, Pi, or other output formats stay behind
  ACP adapters.
- The Workspace child role must not become `apps/workspace-daemon`.

See [`../../docs/architecture.md`](../../docs/architecture.md) for the
canonical system architecture.
