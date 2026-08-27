# CoForge

CoForge connects cloud collaboration with code-agent execution on a user's Computer. This glossary fixes the identities and relationships that authorization decisions may refer to.

## Language

**User**:
A person authorizing an interactive management action. A User is not the service identity used by background machine processes.
_Avoid_: Account, operator, Computer user

**Computer**:
The long-lived service identity of one per-user CoForge installation profile registered with one CoForge issuer. It is distinct from both the User who registered it and the physical hardware.
_Avoid_: Device, daemon, machine credential

**Workspace**:
The top-level logical boundary for collaboration, membership, permissions, conversations, and Agents.
_Avoid_: Organization, Agent workspace

**Workspace–Computer connection**:
The server-owned association authorizing one Computer to host one Workspace. Authority and online state for one registration never flow through another registration on the same Computer.
_Avoid_: Workspace login, machine assignment

**Workspace session**:
A short-lived connection identity derived from exactly one active Workspace–Computer connection. It cannot confer authority for another Workspace or for User management actions.
_Avoid_: Computer login, global daemon session

**Agent**:
The logical collaborator that receives messages, produces responses, and is named in server-side authorization and audit records.
_Avoid_: Agent process, provider runtime

**Agent status**:
The two-value online status derived from the local Agent runtime process: `online` while the process is running and `offline` after it exits or is stopped. `agent:status` is emitted only when this value changes; it is not an independently persisted state machine.
_Avoid_: starting, ready, degraded, failed

**Agent activity**:
The timeline of runtime lifecycle and provider diagnostics reported by the workspace worker over its Workspace Connection WSS. `agent:status` is sparse and reports only `online` or `offline` transitions; `agent:activity` is frequent and records starting, stopping, turn, tool, error, warning, and idle details. Every activity uses the same display contract: `activity`, `level`, `message`, and `occurred_at`. Status and activity entries share one monotonic per-connection sequence and are durably spooled before sending, so replay preserves order. The activity identifies commands, file operations, or diagnostics while message carries the safe command, workspace-relative path, or original provider text. Provider error and warning text is kept in its original language and wording; CoForge may redact secrets, but does not translate or paraphrase it.
_Avoid_: Agent status, runtime state machine

**Agent workspace**:
The durable filesystem working area for one Agent within one Workspace on one Computer. It survives Agent runtime replacement and provider changes, and is not itself a logical Workspace.
_Avoid_: Workspace, repository, provider home, runtime directory

**Agent runtime**:
A short-lived execution and audit identity for one Agent in one Workspace runtime session. Its configuration selects a provider, model, and reasoning behavior; provider-specific adapters translate that configuration into the native runtime settings. It never inherits User or Computer authority.
_Avoid_: Agent token, code-agent installation

**Agent capacity**:
The machine-level limit owned by coforge-daemon for concurrently resident Agent runtimes across all workspace workers. The Daemon enforces it through one shared AgentRuntimePool; each workspace worker's AgentProcessManager requests capacity before starting an Agent runtime.
_Avoid_: Slot pool, workspace quota, worker count

**AgentRuntimePool**:
The Daemon-owned component that tracks and allocates machine-level Agent capacity across all workspace workers. Workspace workers use it through their AgentProcessManager and do not maintain a separate capacity pool.
_Avoid_: Runtime lease, SlotManager, workspace capacity pool

**AgentProcessManager**:
The single component in each workspace worker that starts and stops that Workspace's Agent runtimes. It must acquire capacity from the Daemon-owned AgentRuntimePool before starting a runtime.
_Avoid_: AgentRuntimePool, provider adapter, process slot manager

**Credential Proxy**:
The trusted daemon-owned boundary that authorizes a local Agent runtime to invoke an approved operation without exposing a bearer credential to the Agent process.
_Avoid_: Token endpoint, token store, loopback HTTP proxy

**machine_id**:
A stable public identifier for one Computer installation profile. It is neither a credential nor necessarily the primary key of a server-side Computer record.
_Avoid_: Hardware fingerprint, machine secret, Computer token
