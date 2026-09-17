# ADR 0027: Agent-prepared action cards

Status: accepted
Date: 2026-09-17

## Context

ADR 0025 gated Agent-initiated Workspace changes to a human-only seam: "Agent
CLI channel commands, action cards, private channels, and channel member
removal remain open follow-ups; standing instructions must not claim or
emulate them ahead of an implementation." `docs/architecture.md` §6.4 records
the same limit: creating a channel, creating an Agent, and adding a channel
member are human/Web-side actions today, with no Agent CLI entry point.

The product owner asked for the next step, in their own words: "参考 raft 的
就行" (mirror Raft). Raft Computer 1.0.32 (the reference build; see
`docs/agents/reference-cli-research.md`) gives an Agent a `raft action
prepare` command that posts a typed "action card" — a proposed
`channel:create`, `agent:create`, `channel:add_member`, or `integration:*`
operation — as a message a human later commits from the chat UI under their
own identity. The Agent never executes the action itself; the card only
records what it is asking for. Reference points used for this PR, all
recovered from the 1.0.32 binary per that research guide:

- Contract: `packages/shared/src/actionCards.ts`
  (`channelCreateOperationSchema`, `agentCreateOperationSchema`,
  `channelAddMemberOperationSchema`, `integration:*` schemas,
  `actionCardActionSchema` discriminated union).
- CLI command: `packages/daemon/dist/dist-CI7CMKZV.js` (`src/commands/
  action/prepare.ts`, `raft action prepare --target <target>`, heredoc/raw
  JSON stdin, local zod validation, `validateActionCardAction` cross-field
  rules, `POST /prepare-action`, success text `Action card posted to
  <target> as message <uuid> (short <first 8>). The human can click the
  action verb to commit.`).
- Built-in Agent prompt text about action cards:
  `packages/daemon/dist/chunk-TEGPBMW7.js`.

## Decision

1. CoForge ships exactly three action-card kinds in this PR:
   `channel:create`, `agent:create`, `channel:add_member`. Raft's
   `integration:*` kinds (approve-agent-login, install-marketplace-app,
   register-app, update-app-registration, recover-app-owner) are out of
   scope — CoForge has no equivalent integration marketplace yet.
2. The contract lives in `packages/coforge-sdk/src/agent/action-cards.ts`:
   zod schemas mirroring Raft field for field, adapted to CoForge naming and
   identity rules (CoForge channel-name regex, CoForge Agent-name regex, no
   `runtime`/`model`/`reasoning` fields on `agent:create` — those stay
   human-picked technical fields, unlike anything Raft exposes here either),
   plus `validateActionCardAction` for the same cross-field rules
   (`agent:create` accepts only one of `suggestedComputer`/
   `requiredComputer`; `channel:add_member` requires at least one human or
   agent) and a discriminated `actionCardActionSchema` union.
3. An Agent identifies every human, Agent, channel, and computer in a card
   by handle (`@alice`, `alice`, `#general`, `general`) or UUID, never a raw
   database id it invented. `ActionCards.prepare`
   (`apps/web/src/server/conversations/action-cards.server.ts`) resolves
   every handle to a UUID at prepare time — the same moment Raft's server
   resolves `resolveUserByName`/`resolveAgentByName`/`resolveChannelByName`
   — and persists only the resolved, UUID-only payload. An unresolvable
   handle is a 422 `INVALID_HANDLE` naming the offending field, never a
   silent guess.
4. `target` resolution and membership reuse the same grammar and code path
   as Agent `message send` (`#channel[:thread]`, `@user[:thread]`,
   `getAgentChannel`/direct-conversation resolution): the Agent must already
   be a member of the target conversation, exactly like sending an ordinary
   message. This PR adds no new Agent CLI channel-membership command.
5. Preparing a card creates two rows in one transaction, using the same
   conversation lock as an ordinary Agent send: a normal `Message` (a
   one-line summary such as `Action card: create channel #design`, plus the
   Agent's `draftHint` on the next line when given) and an `ActionCard` row
   keyed by that Message's id — the same message-anchored pattern
   `docs/architecture.md` §6.6 already uses for Task. The card is an
   ordinary Agent message for every existing rule: it never wakes another
   Agent, it follows the same mute/mention/notification and realtime-publish
   path as any other Agent-authored message, and Task and public-channel
   behavior are unaffected.
6. `channel:create` with `visibility: "private"` is accepted by the schema
   (the field stays in the contract for the private-channel PR ADR 0025
   already anticipates) but rejected at prepare time with 422
   `INVALID_ACTION` ("private channels are not supported yet"), because
   CoForge has no private-channel implementation yet.
7. This PR persists the card and renders it as a normal message with a
   readable summary. It does **not** implement the human commit action, the
   card UI, or the actual `channel:create`/`agent:create`/
   `channel:add_member` side effect — those are the next PR. Standing
   instructions accordingly tell the Agent the card is recorded for a human
   to act on, not that clicking a verb executes anything yet (that claim
   becomes true only once the next PR ships).
8. Agent creation keeps its ADR 0025 authority gate: `agent:create` action
   cards do not bypass it. The Agent only proposes the card; the human who
   later commits it does so under their own identity and remains subject to
   `assertCanCreateAgents` (owner/admin) when the commit PR lands. Preparing
   a card today creates no Agent, channel, or membership, so this PR
   introduces no privilege escalation.

## Rejected alternatives

- Implementing the human commit flow and card UI in this same PR: rejected
  as too large for one change; the product owner's direction was "mirror
  Raft's prepare step first," and Raft itself separates `action prepare`
  (Agent-facing) from the human's commit action in the client UI.
- Including Raft's `integration:*` kinds now: rejected, CoForge has no
  integration marketplace or app registration surface to commit them
  against; adding the schemas without a commit target would be dead
  contract surface.
- Letting the Agent supply raw UUIDs directly instead of resolving handles
  server-side: rejected — matches Raft's own design (`resolveUserByName`
  etc.) and keeps an Agent's-eye view of the Workspace in human-readable
  handles, never database ids it has to invent or leak.
- Skipping the target-membership check because the card is "just a
  proposal": rejected — an Agent that is not a member of a channel cannot
  read or write there either; an action card is an ordinary message for
  delivery and authorization purposes and must follow the same rule.

## Consequences

- `ActionCard` is a new Prisma model, message-anchored like `Task`
  (`messageId` PK, FK to `Message` with `(messageId, conversationId)`,
  cascade on delete), storing `kind`, the resolved UUID-only `payload` Json,
  `draftHint`, `preparedByAgentId`, and a `state` that defaults to
  `"pending"` and stays there until the commit PR lands.
- `coforge action prepare --target <target>` is a new Agent-facing CLI
  command, added alongside `message send`/`task create`/`reminder
  schedule`, routed through the daemon's local Agent proxy exactly like
  `task`/`reminder` (`packages/daemon/src/agent-proxy.ts`
  `LOCAL_PROXY_ROUTES`, `packages/coforge-sdk/src/agent/routes.ts`
  `actionPrepare`).
- Standing instructions (`packages/daemon/src/code-agent/agent-instructions.ts`)
  gain a short section, equivalent to Raft's FAQ about action cards: when a
  human asks for a new channel, a new Agent, or to add someone to a channel,
  the Agent prepares a card instead of claiming the resource exists.
- No data migration beyond the additive `action_cards` table; rollback
  drops the new route, CLI command, and table without touching Task,
  Message, or public-channel data.

## Validation and rollback

- `packages/coforge-sdk/src/agent/action-cards.test.ts` covers the three
  schemas and `validateActionCardAction` (valid examples, private accepted
  by the schema but not by the server, both-computers rejected, empty
  `channel:add_member` rejected, bad names rejected).
- `packages/coforge/test` covers CLI arg parsing, heredoc/raw JSON stdin,
  local validation errors, and success-text rendering against a mocked
  transport.
- `apps/web/test/action-cards.integration.ts` covers preparing each kind
  into `#general` as an enrolled Agent (handles resolved from `@alice`,
  `alice`, `#general`, and a raw UUID; unknown handle named by field;
  private rejected; existing channel/agent name conflicts; a non-member
  Agent denied with `ACCESS_DENIED`; a thread target posting into the
  thread).
- Rollback is reverting the route, CLI command, proxy wiring, and Prisma
  migration; no production data depends on `ActionCard` existing.

## Commit and cancel (added 2026-09-17)

This section implements the follow-up decision 7 announced above: a human
sees, commits, and cancels a pending card from the CoForge Web UI.

1. **Views.** `ActionCards.viewsFor(workspaceId, viewerUserId, messageIds)`
   (`apps/web/src/server/conversations/action-cards.server.ts`) resolves
   every card referenced by a page of messages in one batched set of
   queries — never one query per message — and returns kind-specific
   display fields (resolved names for humans/Agents/channels/computers,
   falling back to `"unknown"` for a deleted reference), `committedBy`,
   `committedAt`, `result`, and per-viewer `canCommit`/`canCancel`. The
   shared helper `attachActionCardViews` merges this into the existing
   channel and direct-conversation message-page Server Functions
   (`channels.functions.ts`, `conversations.functions.ts`); the
   `channelMessageView`/`toBrowserMessage`/`mapBrowserMessage` server
   functions gained an `actionCard` field for the caller to fill in, but do
   not query `ActionCard` rows themselves, keeping every Prisma access to
   action cards inside `ActionCards`.
2. **Commit executes the existing module under the human's identity, then
   marks the card.** `channel:create` commits through `PublicChannels
   .create` (any Workspace member, unchanged from ADR 0025) followed by
   `PublicChannels.addMembers` for the human-selected initial humans/Agents.
   `channel:add_member` commits through `PublicChannels.addMembers` directly,
   which already requires the actor to be a member of the target channel
   (`ACCESS_DENIED` otherwise — this is how a plain member is denied when
   they are not in the channel). `agent:create` deliberately does **not**
   get its own commit method on `ActionCards`; it commits through the
   existing `createAgent` Server Function (`agents.functions.ts`), which
   already submits the human's full runtime form (runtime/model/reasoning
   remain human-picked, per the original decision) and already enforces
   `assertCanCreateAgents` (owner/admin). `ActionCards.assertAgentCreate
   Committable` only performs the shared pending/workspace/read-access guard
   before that call, and `ActionCards.completeAgentCreate` marks the card
   after it succeeds — this keeps the Agent-creation authority gate as the
   one place it has always lived (ADR 0025) instead of duplicating it.
3. **Ordering, not a pre-lock, is the concurrency guard.** Every commit path
   executes the real operation *first*, then marks the card `executed` with
   a conditional `updateMany({ where: { messageId, state: "pending" } })`;
   `count === 0` is reported as `CONFLICT`. A double click is handled by
   the operation's own idempotency: `PublicChannels.create` hits the
   channel-name uniqueness constraint (`CONFLICT`) or `ManageAgents.create`
   hits the Agent-name constraint on the second attempt, and
   `PublicChannels.addMembers`'s `skipDuplicates` makes a second
   `channel:add_member` submit a harmless no-op that then finds the card
   already `executed` and reports `CONFLICT` even though its own operation
   "succeeded." This was chosen over locking the card row for the duration
   of the operation because the operation already has to be safe against
   concurrent identical requests for other reasons (the Agent could also be
   attempting the same create), and a second lock would only duplicate that
   safety while adding a lock-scope decision with no behavioral benefit.
4. **Guard.** Before executing, `ActionCards.loadPendingCard` verifies the
   card exists in the caller's Workspace, that the viewer can read the
   conversation the card was posted in (reusing
   `ConversationHistory.authorize`, so a channel is open to any Workspace
   member and a direct conversation only to its two participants), that the
   kind matches, and that the card is still `pending` — this produces a
   fast, friendly `CONFLICT`/`ACCESS_DENIED`/`NOT_FOUND` for the common case,
   ahead of the atomic re-check in point 3.
5. **Cancel** is allowed for the preparing Agent's owner (`Agent.ownerId`)
   or a Workspace owner/admin, `pending → cancelled` via the same
   conditional-`updateMany` pattern.
6. **Realtime.** Commit and cancel both publish the existing
   `ConversationRealtime.messageAvailable` for the card's message. The
   browser does not open a new Centrifugo channel for this: on the existing
   per-conversation realtime signal, and on window focus, it calls a new,
   small `loadActionCardStates({ messageIds })` Server Function scoped to
   just the pending cards currently rendered, instead of re-fetching the
   whole page (`conversation-queries.ts`'s `useConversationRealtime`
   callback, alongside the existing message-update reconciliation).
7. **Agent-visible outcome.** Rather than posting a second, system-authored
   follow-up message (which would be one more thing for an Agent to
   correlate back to the card), the single function that renders
   Agent-facing message text (`toAgentMessage` in
   `direct-conversation.repositories.server.ts`) appends
   `` [action card: pending|executed|cancelled]`` to a card message's body.
   An Agent reading the conversation therefore sees the card's current
   state the same way it reads any other message, without a new read path.
   `packages/daemon/src/code-agent/agent-instructions.ts`'s "Action cards"
   section and `packages/coforge/README.md` were updated to tell the Agent
   to re-read the card message (`coforge message read --target … --around
   <message-id>`) before claiming the resource exists.
8. **`channel:create`'s `description` still has no column.** ADR-accepted
   scope for this PR did not add one; the card UI shows the Agent-proposed
   description as context on the card itself (from the already-persisted
   `ActionCard.payload`) but does not pass it to `PublicChannels.create`
   (which has no such parameter) and it is not persisted on the created
   `Conversation`. A future PR that adds a channel `description` column can
   wire this through without changing the card contract.

### Rejected alternatives (commit and cancel)

- Giving `ActionCards` its own `channel:create`/`channel:add_member`
  *and* `agent:create` commit methods, all called uniformly from
  `action-cards.functions.ts`: rejected for `agent:create` specifically,
  because the Agent-create form needs the human's full runtime selection
  (provider, model, reasoning, API key, Computer) that only the existing
  Agent-create dialog and `createAgent` already know how to collect and
  validate; re-implementing that as a second path inside `ActionCards`
  would duplicate `ManageAgents.create`'s validation and the authority gate
  in two places.
- Locking the `ActionCard` row (e.g. `SELECT … FOR UPDATE`) for the
  duration of the commit operation: rejected as unnecessary — see point 3
  above; the underlying operations are already safe against concurrent
  duplicate attempts for reasons unrelated to action cards.
- A dedicated Centrifugo channel for action-card state changes: rejected —
  the existing per-conversation `ConversationRealtime.messageAvailable`
  signal already reaches every open viewer of that conversation, and this
  PR's small `loadActionCardStates` Server Function is enough to turn that
  signal into a targeted refresh without new transport.

### Validation and rollback (commit and cancel)

- `apps/web/test/action-cards.integration.ts` extends the existing suite:
  committing each kind creates the resource and marks the card `executed`
  with `committedByUserId`/`result`; a second commit is `CONFLICT`;
  `agent:create` by a plain member is `ACCESS_DENIED` and leaves the card
  `pending`; `channel:add_member` by a non-member of the channel is
  `ACCESS_DENIED`; cancel succeeds for the Agent's owner and for an admin
  and is `ACCESS_DENIED` for another plain member; views expose
  `canCommit`/`canCancel` per viewer, resolved names, and the committer on
  an executed card; an Agent-facing read shows the `[action card: …]` state
  suffix.
- Rollback is reverting this section's Server Functions
  (`action-cards.functions.ts`), the `ActionCards` commit/cancel/`viewsFor`
  methods, the `createAgent` guard, the `toAgentMessage` suffix, and the UI
  (`action-card.tsx`, the dialog prop additions); no schema change to
  undo (`ActionCard.state`/`committedByUserId`/`committedAt`/`result` were
  already part of the model from the original PR).
