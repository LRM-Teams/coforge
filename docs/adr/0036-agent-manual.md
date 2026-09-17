# ADR 0036: A server-served Agent Manual, modelled on Raft's `raft manual`

Status: accepted
Date: 2026-09-17
Approved by: Frank on 2026-09-17

## Context

`packages/daemon/src/code-agent/agent-instructions.ts` is CoForge Agents' (Claude Code, Codex,
Kiro, Pi) one standing prompt. Every how-to fact CoForge wants an Agent to know today has to live
in that prompt, which means:

- the prompt grows without bound as CoForge adds capabilities (GitHub repository access, in the
  companion PR #326 "Project code and GitHub" section, is the next one);
- correcting or extending a how-to fact requires a Daemon release, even though the daemon itself
  did not change;
- a fact that is only relevant to some tasks (e.g. "how to open a pull request") still costs every
  Agent, on every turn, the tokens to read it.

Raft Computer 1.0.32 solves the same problem with `raft manual get|search`, a CLI surface backed
by server-side `/knowledge` routes: the standing prompt stays a short capability index, and
long-form docs are fetched on demand. Raft requires `--intent`/`--reason` on every call and logs
each call server-side.

## Decision

CoForge adds `coforge manual get <topic>|index` and `coforge manual search "<keywords>"`,
modelled on Raft 1.0.32's `raft manual` / `/knowledge` routes:

- Wire shape matches Raft's response field names (`docId`, `topicOrPath`, `docVersion`,
  `docState`, `contentType`, `content`, and search's `slug`/`title`/`firstScreen`), under
  CoForge's own route names (`GET /api/agent/v1/manual`, `GET /api/agent/v1/manual/search`, not
  `/knowledge`). Both routes require `--intent` and `--reason`, 12-500 characters each, validated
  client-side before sending and again server-side; when both are invalid, one error names both,
  matching Raft's behavior.
- `--intent`/`--reason` are recorded server-side for every `get`/`search` call, alongside the
  topic or query and whether it hit, in a new `AgentManualEvent` (this repository has no
  general-purpose Agent event log to reuse; `ReminderEvent`/`TaskHistoryEvent` are the closest
  precedent and are not general either). An invalid-input 400 is never recorded. A logging
  failure never fails the read.
- Search v1 is plain keyword scoring (tokenize, drop tokens under two characters except CJK runs,
  match latin tokens from a word start and CJK tokens by substring, weight title/slug over
  summary over body, require at least one hit, top 5) — no embeddings, and none of Raft's typo or
  concept expansion (`matched: x → y (typo|concept)`) or `--scope recipes`. A smarter ranker is a
  later, separately decided change.
- Topic content ships as two real topics (`github`, `manual`) plus a generated `index`, as
  markdown files under `apps/web/src/server/agents/manual/topics/`, imported with Vite's `?raw`
  suffix (verified to also work unmodified under `bun test`, so the same import behaves
  identically in the production build and the test runner). Content lives in Web/backend so it
  can change without a Daemon release, per the stated goal.
- The standing prompt gains exactly one bullet under "### Workspace and attachments" pointing at
  `manual get index` / `manual search`, the required `--intent`/`--reason`, and the never-put-
  secrets rule. It does not restructure the prompt; that is a separately scoped follow-up (PR 2
  of this feature).

## Continuous alignment

The Manual is an alignment surface, not a one-off (Frank, 2026-09-17). Two things must stay true:

- **Against Raft.** Command grammar, required context fields, response fields, stdout formats and
  error codes follow Raft's current `raft manual`. When a new Raft release changes them, CoForge
  re-diffs and either follows or records the divergence here. Known divergences today: route
  names (`/manual` instead of `/knowledge`); no `--scope`; no typo/concept expansion; the CLI
  reports error codes upper-cased (`KNOWLEDGE_NOT_FOUND`) to match every other CoForge `CliError`
  code, while the wire `errorCode` stays Raft's lower-case value; no `raft knowledge` legacy alias.
- **Against CoForge itself.** A topic describes real CLI and server behaviour, so a PR that
  changes an Agent-facing command, flag, output or permission updates the matching topic in the
  same PR, the way it already must update the standing prompt. `AgentManualEvent` rows with
  `outcome = not_found` are the backlog of topics Agents looked for and did not find.

## Prompt versus Manual placement

What stays in the standing prompt and what moves to the Manual is decided one section at a time,
each step following what Raft does with the same section and each verified on staging before the
next (Frank, 2026-09-17). Raft 1.0.32 builds its prompt from named section builders
(`buildRaftCliGuideSections`); the daemon always uses the `managed-runner` audience, and the
`self-hosted-runner` audience of the same builders generates the Manual topics. Only Tasks differs
by audience; messages, threads, channels, reminders and the rest stay in the prompt in full.

| Step | Section | Raft 1.0.32                                                                                                                                                                    | CoForge                                                                                                                                                        |
| ---- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Tasks   | managed-runner keeps four paragraphs (claim rule, top-level only, failed claim is a lock, `in_review` → `done`) and points at the Manual; the long variant is the Manual topic | same split; topic `tasks` holds the previous prompt text verbatim; the short variant keeps CoForge's two extra sentences about parent targets and thread roots |

A section Raft keeps in the prompt is not moved without a recorded decision here.

`agent-instructions.ts` mirrors that layout: `buildCoforgeCliGuideSections()` returns the named
sections in rendered order, one `build<Name>Section()` each, so a step edits exactly one builder.
Raft's `audience` parameter is not copied yet. CoForge has only daemon-spawned Agents (Raft's
`managed-runner`), so each builder is that variant; the parameter arrives together with a
self-hosted Agent client, at which point Manual topics can be generated from the same builders as
Raft does instead of being written by hand.

## Alternatives rejected

- **Provider-native skills** (Claude Code / Codex / Kiro / Pi each have some notion of
  file-based or discoverable "skills"). Rejected: discovery mechanics differ across the four
  providers CoForge adapts, so this would need four separate integrations instead of one CLI
  surface; and CoForge's existing `installAssignedSkills` never overwrites an installed skill
  file, so a corrected or updated doc would silently keep serving stale content with no visible
  failure — the exact awareness gap this ADR is meant to close, not reproduce.
- **Keep growing the standing prompt.** Rejected for the reasons in Context: unbounded prompt
  growth, a Daemon release for every doc correction, and a fixed per-turn token cost paid whether
  or not the fact is relevant to the current task. Awareness-level facts (what a capability is,
  that it exists) still belong in the standing prompt; only long-form how-to detail moves to the
  Manual.

## Consequences and migration

New Prisma model `AgentManualEvent` (migration `20260917091342_agent_manual_event`), new SDK
routes/types (`packages/coforge-sdk/src/agent/manual.ts`, `routes.ts`, `client.ts`), new Web
routes/service (`apps/web/src/routes/api/agent/v1/manual.ts`, `manual_.search.ts`,
`apps/web/src/server/agents/agent-manual.service.ts` and `manual/`), new Daemon wiring
(`agent-proxy.ts`, `daemon-connection.ts`, `daemon-runtime/runtime.ts`, `daemon/index.ts`), and
new CLI commands (`packages/coforge/index.ts`, `src/local-client.ts`, `src/manual-format.ts`).
`tool-activity.ts` classifies `manual get|search` like other read-only `coforge` commands
(`get_manual`/`search_manual`) for the Agent Activity feed.

This is additive: no existing route, CLI command, or standing-prompt section changes shape.
Adding a third topic later is a content-only change (append to the registry and its markdown
file); it does not require a schema or wire change.

## Validation and rollback criteria

Unit tests cover: SDK decoders (`packages/coforge-sdk/src/agent/manual.test.ts`), CLI arg parsing
and client-side `--intent`/`--reason` validation (`packages/coforge/test/cli.test.ts`), the
`manual get`/`manual search` stdout formatters, the web service's slug validation, generated
index content, keyword search ranking including a CJK query, `firstScreen` truncation, and
not-found handling (`apps/web/test/agent-manual-search.test.ts`,
`agent-manual-service.test.ts`, `agent-manual-http.test.ts`), the daemon proxy's GET forwarding and
`errorCode` passthrough (`packages/daemon/test/agent-proxy.test.ts`), and `tool-activity.test.ts`.
Rollback is a plain revert; the new Prisma table has no other table depending on it, and no
existing route or CLI command is modified in a way this revert would need to reverse.
