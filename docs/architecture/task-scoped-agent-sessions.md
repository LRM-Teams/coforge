# Task-scoped Agent sessions

## Decision

A CoForge Agent keeps one stable identity, but a delegated Task runs in its own execution session. The Agent identity is the authority used for membership, permissions, messages, and Task ownership. The execution session is disposable context used to complete one Task.

A Task session must never be implemented by silently replacing the Agent's standing native session. The current runtime has one long-lived native session per Agent; replacing it would make parallel Tasks race for the same session and would erase the Agent's normal conversation context.

## User-visible behavior

When a coordinator delegates `Investigate login timeout` to `backend`, CoForge creates one Task execution session for `backend`. That session receives:

- the Task title, description, number, and original message/thread;
- the repository, project, workspace, and Agent workspace directory;
- the Agent's stable identity and permission scope;
- only the minimal referenced messages or files needed by the Task.

It does not receive the Agent's unrelated channel or DM history. The Agent can still send messages as `backend`, update the Task, open a PR, and reply in the original thread. When the Task is closed, the execution session is disposable and does not become the Agent's standing chat context.

For example:

1. A human asks `大家看看登录超时问题` in a coordinated channel.
2. The coordinator claims the Task and delegates it to `backend`.
3. `backend` gets a new Task session containing the Task and its relevant thread.
4. `backend` investigates and reports in the thread. A separate Task assigned to `backend` gets a separate session, even if both run at the same time.
5. `backend`'s normal Agent session remains available for ordinary questions and channel coordination.

## Data model

Add a `TaskExecutionSession` record with these fields:

- `id`: CoForge execution-session UUID;
- `workspaceId`, `agentId`, and `taskMessageId`: composite ownership boundary;
- `nativeSessionId`: provider session ID, when the provider exposes one;
- `status`: `starting | running | waiting | completed | failed | cancelled`;
- `requestId` and `launchId`: idempotency and launch fencing;
- `createdAt`, `startedAt`, `finishedAt`, and `lastError`.

The record is created in the same transaction that assigns the Task. A unique constraint on `(taskMessageId, agentId)` makes retries return the existing execution session instead of starting a second worker. A Task has at most one active execution session per Agent; a future retry creates a new attempt linked to the same Task.

The Task itself remains the source of truth for ownership and status. The execution-session record is runtime state and can be recreated after a daemon restart.

## Delivery contract

Extend Agent Task delivery with `taskExecutionSessionId` and a `taskWake` kind. Ordinary channel and DM deliveries keep their existing behavior. A Task wake is acknowledged only after the daemon accepts responsibility for that execution session.

The wake payload contains IDs and a compact task envelope, rather than a transcript dump. The daemon can fetch the authoritative Task and referenced messages through the Agent API. This keeps prompts small and prevents stale or unrelated chat history from entering the Task session.

The Task session must use the same Agent credentials and workspace permissions as the stable Agent. Its outbound messages and Task mutations are attributed to the stable `agentId`, while observability records both `agentId` and `taskExecutionSessionId`.

## Daemon lifecycle

The daemon runtime registry changes from one runtime per `agentId` to:

```text
(agentId, taskExecutionSessionId) -> task runtime
```

The standing Agent runtime remains a separate entry. A Task wake starts a fresh provider session with a Task-specific prompt and the same workspace directory and environment. The provider session is never resumed from the standing Agent session. If the provider cannot create parallel sessions, the daemon queues Task sessions per Agent without changing the standing session.

A Task session is stopped when the Task reaches `done`, `cancelled`, or `failed`, or when its lease expires. A stopped session cannot accept later Task wakes. Re-delivery uses the same execution-session ID and is idempotent; a retry after a terminal failure receives a new attempt ID.

## Concurrency and conflict rules

Task claiming remains the first coordination boundary:

1. Claim the existing Task or original top-level message.
2. Create or reuse the Task execution session under the same transaction/lock.
3. Deliver one task wake to the assigned Agent.
4. Other Agents may review or comment, but cannot create a competing execution session for the same Task unless explicitly assigned.

An Agent may have several Task sessions, subject to a configurable per-Agent concurrency limit. The limit protects the computer and provider without reintroducing shared conversational context.

## Rollout

The implementation should land in these stages:

1. **Schema and SDK:** add `TaskExecutionSession`, statuses, IDs, and codec validation.
2. **Assignment API:** create/reuse a session atomically during Task claim or explicit assignment; expose its ID in Task views.
3. **Delivery:** add the task wake envelope and server delivery persistence.
4. **Daemon:** add the `(agentId, taskExecutionSessionId)` runtime registry and fresh-provider-session launch path.
5. **UI and observability:** show the active attempt, retry state, and terminal error without exposing provider internals.
6. **Migration:** existing Tasks continue through the current Agent session until they are next claimed; no historical Task is silently replayed into a fresh session.

This separation lets the coordination mode ship independently while preserving current Agent behavior until Task-session delivery is available end to end.
