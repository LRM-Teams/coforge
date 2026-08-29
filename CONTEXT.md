# CoForge

CoForge connects cloud collaboration with code-agent execution on a user's Computer. This glossary fixes the identities and relationships that authorization decisions may refer to.

## Language

**User**:
A CoForge-owned person identity authorizing an interactive management action. External login identities map to a User but are not the User's business identity. A User is not the service identity used by background machine processes.
_Avoid_: Account, operator, Computer user

**Computer**:
The long-lived service identity of one per-user CoForge installation profile registered with one CoForge issuer. It is distinct from both the User who registered it and the physical hardware.
_Avoid_: Device, daemon, machine credential

**Workspace**:
The top-level logical boundary for collaboration, membership, permissions, conversations, and Agents.
_Avoid_: Organization, Agent workspace

**Workspace–Computer connection**:
The server-owned association authorizing one Computer to host one Workspace. Its
business identity is the composite `(workspace_id, computer_id)`; any database
surrogate key is internal storage detail. Authority and online state for one
registration never flow through another registration on the same Computer.
_Avoid_: Workspace login, machine assignment

**Workspace session**:
A short-lived connection identity derived from exactly one active Workspace–Computer connection. It cannot confer authority for another Workspace or for User management actions.
_Avoid_: Computer login, global daemon session

Computer has one active Workspace–Computer connection at a time. Setup receives
one external setup intent. Switching stops old runtime processes and WSS, then
replaces only the active config; old local data, credentials, and Agent
directories are retained. No unregister or cleanup is performed.

**Agent**:
The logical collaborator belonging to exactly one Workspace, receiving messages, producing responses, and named in server-side authorization and audit records. It is owned by an external User identity.
_Avoid_: Agent process, provider runtime

**DirectConversation**:
A private conversation in one Workspace between exactly one internal User and
one Agent. Group conversations are not part of the current MVP slice.

**ConversationMember**:
A conversation subject backed by either a User or an Agent, never both. Its
workspace is the same as the conversation's workspace.

**Message**:
A durable text record in a DirectConversation, sent by one of its members.

**Agent status**:
The two-value online status derived from the local Agent runtime process: `online` while the process is running and `offline` after it exits or is stopped. `agent:status` is emitted only when this value changes; it is not an independently persisted state machine.
_Avoid_: starting, ready, degraded, failed

**Agent activity**:
The timeline of runtime lifecycle and provider diagnostics reported by the daemon over its single Workspace Connection WSS. `agent:status` is sparse and reports only `online` or `offline`; `agent:activity` records provider-neutral diagnostics. Provider-specific output remains behind adapters.
_Avoid_: Agent status, runtime state machine

**Agent workspace**:
The durable filesystem working area for one Agent within one Workspace on one Computer. It survives Agent runtime replacement and provider changes, and is not itself a logical Workspace.
_Avoid_: Workspace, repository, provider home, runtime directory

**Agent runtime**:
A short-lived execution and audit identity for one Agent in one Workspace runtime session. Its configuration selects a provider, model, and reasoning behavior; provider-specific adapters translate that configuration into the native runtime settings. It never inherits User or Computer authority.
_Avoid_: Agent token, code-agent installation

**Agent API key**:
A server-issued key authorizing one Agent on one Computer to call the Agent message interface. A new launch replaces every active key for the same Agent, and the key never enters the Agent child process.
_Avoid_: Agent token, Agent credential

**AgentProcessManager**:
The daemon-owned component that starts and stops multiple Agent runtimes for the single configured Workspace. Each Agent has one independent runtime OS child process; the MVP has no capacity pool.
_Avoid_: AgentRuntimePool, provider adapter, process slot manager

**Credential Proxy**:
The trusted daemon-owned boundary that authorizes a local Agent runtime to invoke an approved operation without exposing its Agent API key to the Agent process.
_Avoid_: Token endpoint, token store, loopback HTTP proxy

**machine_id**:
A stable public identifier for one Computer installation profile. It is neither a credential nor necessarily the primary key of a server-side Computer record.
_Avoid_: Hardware fingerprint, machine secret, Computer token
