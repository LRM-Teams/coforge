# CoForge database schema

Status: approved setup identity schema plus approved DirectConversation MVP slice

Database: PostgreSQL 16+

Direct conversations are User↔Agent or between Workspace members (a member may
keep one with themself). Group direct messages are explicitly deferred and have
no database kind, role, or broadcast fields. The schema intentionally keeps
Agent execution `run`/`event` data out of the messaging core.

## Contents

- [Implementation contract](implementation-contract.md): Prisma layout, migration workflow, database scripts, and migration review requirements.
- [Approved setup identity models](identity-models.md): Approved setup identity models: User, UserIdentity, Workspace, Computer bindings, and API keys.
- [Conversation model](conversations.md): The direct conversation and conversation member tables, with the messaging ER diagram.
- [Message tables](messages.md): The canonical message, attachment, and reaction tables.
- [Agent attention and recovery](agent-attention.md): How Agent attention is recovered without a delivery ledger or local inbox/outbox.
- [Atomic write paths](write-paths.md): Atomic write paths for sending a message and creating or finding a direct conversation.
- [Preference tables](preferences.md): Account-level and per-Workspace member preference tables.
- [Identity boundaries, retention, and indexing](boundaries-and-retention.md): Deferred identity foreign keys, pagination and retention rules, and migration status.
- [Workspace Records (proposed)](workspace-records.md): Proposed weekly-report persistence tables.
