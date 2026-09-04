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
The top-level logical boundary for collaboration, membership, permissions, conversations, and Agents. A User's first login creates one Workspace of which they are a member; first login never attaches them to another User's Workspace.
_Avoid_: Organization, Agent workspace, shared default workspace

**Workspace–Computer connection**:
The server-owned association authorizing one Computer to host one Workspace. Its
business identity is the composite `(workspace_id, computer_id)`; any database
surrogate key is internal storage detail. Authority and online state for one
registration never flow through another registration on the same Computer.
_Avoid_: Workspace login, machine assignment

**Workspace session**:
A short-lived connection identity derived from exactly one active Workspace–Computer connection. It cannot confer authority for another Workspace or for User management actions.
_Avoid_: Computer login, global daemon session

Computer has exactly one Workspace–Computer connection at a time. Running setup
again for another Workspace atomically moves the server-owned connection,
revokes every older Daemon API key for that Computer, and resets its Code Agent
installation visibility to private. Agents in the previous Workspace are
detached from the Computer. The local setup flow stops old runtime processes
and WSS, then replaces only the active config; old local data, credentials, and
Agent directories are retained.

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
The volatile two-value lease status derived from the local Agent runtime process: `online` while the process is running and `offline` after it exits or is stopped. Lease renewals may replay the same logical status. Records carry daemon instance, client sequence, and the daemon instance start time in `observedAtMs`; same-instance records order by sequence and cross-instance records order by that instance rank. Browser snapshots and live events use the same merge rule.
_Avoid_: starting, ready, degraded, failed

**Agent activity**:
The timeline of runtime lifecycle and provider diagnostics reported by the daemon over its single Workspace Connection WSS. `agent:status` reports only leased `online` or `offline`; `agent:activity` records provider-neutral diagnostics. Provider-specific output remains behind adapters.
_Avoid_: Agent status, runtime state machine

**Agent workspace**:
The durable filesystem working area for one Agent within one Workspace on one Computer. It survives Agent runtime replacement and provider changes, and is not itself a logical Workspace.
_Avoid_: Workspace, repository, provider home, runtime directory

**Agent runtime**:
A short-lived execution and audit identity for one Agent in one Workspace runtime session. Its configuration selects a provider, model, and reasoning behavior; provider-specific adapters translate that configuration into the native runtime settings. It never inherits User or Computer authority.
_Avoid_: Agent token, code-agent installation

**Agent runtime credential**:
Model-provider authorization material assigned to exactly one Agent's runtime
configuration. The Agent owner may set, replace, or remove it; it is not a
User-wide provider credential and is never shared implicitly with another Agent.
_Avoid_: User API key, Computer credential, Agent API key

**Code Agent installation**:
An external provider executable, currently Codex or Claude Code, discovered from the Daemon's effective PATH on one Computer. Its reported provider and version form a replaceable observation, not a credential or Agent runtime. Built-in Pi is not part of this inventory.
_Avoid_: Agent runtime, Computer registration, built-in Agent

**Code Agent installation visibility**:
Whether a Code Agent installation may be selected by Workspace members other
than the Computer owner. An installation is private by default; its owner may
publish it to the Workspace or make it private again. The owner may always
select it, and publication never grants access outside the Workspace.
_Avoid_: Global runtime, public Computer, installation ownership

**Code Agent model catalog**:
The replaceable model and reasoning selection metadata advertised for one Code Agent provider on one Computer. Pi entries also carry the underlying model provider needed to disambiguate model IDs. A listed model is a supported selection, not proof that the current account is entitled to run it. The catalog validates Agent runtime configuration; it is not a credential or global model registry.

The built-in CoForge catalog is release-generated from the pinned Pi SDK for CoForge's supported single-API-key providers and embedded in `@coforge/agent`/Daemon. External user-installed Pi discovery remains local and dynamic.
_Avoid_: static model list, Agent runtime, provider credential

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
