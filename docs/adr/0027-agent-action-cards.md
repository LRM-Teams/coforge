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
