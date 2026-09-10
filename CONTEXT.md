# CoForge

CoForge connects cloud collaboration with code-agent execution on a user's Computer. This glossary fixes the identities and relationships that authorization decisions may refer to.

## Language

**User**:
A CoForge-owned person identity authorizing an interactive management action. External login identities map to a User but are not the User's business identity. A User is not the service identity used by background machine processes.
_Avoid_: Account, operator, Computer user

**Computer**:
The long-lived service identity of one per-user CoForge installation profile registered with one CoForge issuer. Its `name` is the operating-system hostname and its `displayName` is the human-facing Computer Name or pretty hostname used for display and selection. It is distinct from both the User who registered it and the physical hardware.
_Avoid_: Device, daemon, machine credential

**Workspace**:
The top-level logical boundary for collaboration, membership, permissions, conversations, and Agents. A User's first login creates one Workspace of which they are the owner; first login never attaches them to another User's Workspace.
_Avoid_: Organization, Agent workspace, shared default workspace

**WorkspaceMembership**:
The durable association of one User to one Workspace, carrying exactly one role: owner, admin, or member. Owner is assigned at Workspace creation and cannot be transferred, demoted, removed, or left.
_Avoid_: Workspace role assignment without membership

**WorkspaceInvitation**:
A pending offer for an existing User to join a Workspace as admin or member. Owner cannot be invited; acceptance creates WorkspaceMembership.
_Avoid_: Instant add-without-consent membership, email-only invite identity

**Workspace–Computer connection**:
The server-owned association authorizing one Computer to host one Workspace. Its
business identity is the composite `(workspace_id, computer_id)`; any database
surrogate key is internal storage detail. Authority and online state for one
registration never flow through another registration on the same Computer.
_Avoid_: Workspace login, machine assignment

**Workspace session**:
A short-lived connection identity derived from exactly one active Workspace–Computer connection. It cannot confer authority for another Workspace or for User management actions.
_Avoid_: Computer login, global daemon session

A Computer can have multiple Workspace–Computer connections concurrently. Each
connection has an independent credential and Workspace session; adding one does
not replace, revoke, or detach another. Lifecycle scope is one connection or all
local connections, while installation upgrade scope is the whole Computer.

**Agent**:
The logical collaborator belonging to exactly one Workspace, receiving messages, producing responses, and named in server-side authorization and audit records. It is owned by an external User identity.
_Avoid_: Agent process, provider runtime

**DirectConversation**:
A private conversation in one Workspace between exactly one internal User and
one Agent.

**PublicChannel**:
A named conversation whose history is visible to every human member of its
Workspace; joining enables sending. The default `#general` includes all humans
and Agents automatically. Agent notification preferences do not change membership
or access to history.
_Avoid_: Public internet chat, Agent workspace

**ConversationMember**:
A conversation subject backed by either a User or an Agent, never both. Its
workspace is the same as the conversation's workspace.

**Message**:
A durable text record in a DirectConversation or PublicChannel, sent by one of its members.

**Thread**:
A discussion anchored to one top-level Message in a DirectConversation or
PublicChannel. Its identity is that root Message, not a separate conversation.
Replies belong only to that Thread; a reply cannot anchor another Thread. A
Thread exists only once its first reply is sent. Channel members automatically
follow a Thread by replying or being personally mentioned and may unfollow it
without losing read or reply access. All of an Agent's chats and Threads use the
same Agent runtime session.

**Message target**:
The exact destination within a private User–Agent conversation or PublicChannel:
the main chat/channel or a Thread rooted in a particular Message. Reading or
replying to one target does not consume unread messages in another target. A
sender identity is not a Message target and does not change when that sender
replies in a Thread.

**Task**:
A top-level Message tracked as work in its Conversation, with a conversation-local
number, status and at most one responsible ConversationMember. Its discussion
belongs to the Message's Thread; a Task is not an Agent run or a scheduled job.

**Task owner**:
The User or Agent who has claimed responsibility for a Task, distinct from the
Task's message author or the User who owns the Agent.

**Record**:
A Workspace collaboration surface for durable written work outside chat:
weekly-report cycles, member reports, highlights, favorites, send templates,
and notes. It is not a Message inbox or an Agent run.
_Avoid_: Message, Task, Agent Activity

**WeeklyReportCycle**:
One ISO week bucket inside a Workspace that groups that week's template,
member reports, and highlight.
_Avoid_: Calendar month, chat thread

**WeeklyReport**:
One User-authored weekly-report document in a WeeklyReportCycle, either the
cycle template draft or a member submission, carrying structured outline
content and a submission status.
_Avoid_: Message body, Task

**WeeklyReportHighlight**:
The Workspace-level key-points document for one WeeklyReportCycle.
_Avoid_: Member WeeklyReport, channel summary

**WeeklyReportTemplate**:
Reusable Workspace send configuration for weekly reports (name, dimensions,
recipients, frequency, and send time), distinct from a cycle's template draft.
_Avoid_: WeeklyReport content, Message template

**RecordComment**:
A comment attached to a Record subject (report, highlight, or cycle). Authors
may be a User now, or later a system/assistant identity for AI side panels.
_Avoid_: Message, Agent Activity

**Agent status**:
The volatile two-value lease status derived from the local Agent runtime process: `online` while the process is running and `offline` after it exits or is stopped. Lease renewals may replay the same logical status. Records carry daemon instance, client sequence, and the daemon instance start time in `observedAtMs`; same-instance records order by sequence and cross-instance records order by that instance rank. Browser snapshots and live events use the same merge rule.
_Avoid_: starting, ready, degraded, failed

**Agent activity**:
The timeline of runtime lifecycle and provider diagnostics reported by the daemon over its single Workspace Connection WSS. `agent:status` reports only leased `online` or `offline`; `agent:activity` records provider-neutral diagnostics. Provider-specific output remains behind adapters.
_Avoid_: Agent status, runtime state machine

**Agent workspace**:
The durable filesystem working area for one Agent within one Workspace on one Computer. It survives Agent runtime replacement and provider changes, and is not itself a logical Workspace.
_Avoid_: Workspace, repository, provider home, runtime directory

**Agent session**:
The native conversational context used by one Agent, distinct from its runtime
process and from a Workspace session. Replacing the runtime does not by itself
discard this context. A recoverable association is scoped to that Agent, Workspace,
Computer, and provider. It is not a CoForge Message history or a transcript view.

**Restart Agent**:
Stop the Agent runtime and start it again, preferring the same Agent session and
preserving the Agent workspace. An empty session starts fresh silently; a known
missing or safely non-replayable session may start a new session with a new identity
to restore availability. Authentication, network, ambiguous, permission, corruption,
and other I/O failures do not become fresh sessions.

**Reset Session**:
Stop the Agent runtime, discard its current session association, and start a new
Agent session in one user operation. Preserve the Agent workspace and old native
session files.

**Full Reset**:
Stop the Agent runtime, delete all contents of only its Agent workspace, discard
its current session association, and start a new Agent session in one confirmed
user operation. It does not delete cloud Messages, provider home directories,
Global Skills, or another Agent's files.

**Agent runtime**:
A short-lived execution and audit identity for one Agent in one Workspace runtime session. Its configuration selects a provider, model, and reasoning behavior; provider-specific adapters translate that configuration into the native runtime settings. It never inherits User or Computer authority.
_Avoid_: Agent token, code-agent installation

**Agent runtime credential**:
Model-provider authorization material assigned to exactly one Agent's runtime
configuration. The Agent owner may set, replace, or remove it; it is not a
User-wide provider credential and is never shared implicitly with another Agent.
_Avoid_: User API key, Computer credential, Agent API key

**Code Agent installation**:
An external provider executable, currently Codex or Claude Code, discovered from the Daemon's effective executable search path on one Computer. That path includes the service environment and the user's standard local executable directory. Its reported provider and version form a replaceable observation, not a credential or Agent runtime. Built-in Pi is not part of this inventory.
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
A stable internal registration identifier for one Computer installation profile. It supports identity reconciliation but is neither a credential, a user-facing Computer name, nor necessarily the primary key of a server-side Computer record.
_Avoid_: Hardware fingerprint, machine secret, Computer token
