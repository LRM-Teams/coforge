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

**Workspace–Computer binding**:
The server-owned association authorizing one Computer to host one Workspace. Authority and online state for one binding never flow through another binding on the same Computer.
_Avoid_: Workspace login, machine assignment

**Workspace session**:
A short-lived connection identity derived from exactly one active Workspace–Computer binding. It cannot confer authority for another Workspace or for User management actions.
_Avoid_: Computer login, global daemon session

**Agent**:
The logical collaborator that receives messages, produces responses, and is named in server-side authorization and audit records.
_Avoid_: Agent process, provider runtime

**Agent runtime**:
A short-lived execution and audit identity for one Agent in one Workspace runtime session. It never inherits User or Computer authority.
_Avoid_: Agent token, code-agent installation

**Agent capacity**:
The machine-level limit owned by coforge-daemon for concurrently resident Agent runtimes across all workspace workers. A workspace worker cannot create capacity.
_Avoid_: Slot pool, workspace quota, worker count

**Runtime lease**:
A grant of machine-owned Agent capacity from coforge-daemon to one workspace worker for an Agent runtime. Its lifecycle and cross-process protocol remain undecided.
_Avoid_: Slot, Agent assignment, execution token

**Credential Proxy**:
The trusted daemon-owned boundary that authorizes a local Agent runtime to invoke an approved operation without exposing a bearer credential to the Agent process.
_Avoid_: Token endpoint, token store, loopback HTTP proxy

**machine_id**:
A stable public identifier for one Computer installation profile. It is neither a credential nor necessarily the primary key of a server-side Computer record.
_Avoid_: Hardware fingerprint, machine secret, Computer token
