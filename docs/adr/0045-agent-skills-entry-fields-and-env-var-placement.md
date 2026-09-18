# ADR 0045: Skill entry fields follow the reference model; env vars move into the Runtime config dialog

Status: accepted
Date: 2026-09-18

## Context

The Agent profile panel's Skills section and its standalone Environment variables editor both
predate a direct comparison against the shipped Raft Computer reference. Two gaps stood out:

1. The Skills wire and UI carried only `name`/`description`/`sourcePath`, and `name` was taken
   from the skill's frontmatter `name:` field when present. The reference never does this: its
   `name` is always the skill's own directory (or the flat command file's basename), and a
   separate `displayName` carries the frontmatter override. CoForge's `name` could therefore
   diverge from any real path segment, and the UI had no way to show a skill's actual
   user-invocable slash name (`/name`) distinct from its display text.
2. Environment variable overrides lived in their own always-visible section
   (`agent-environment-editor.tsx`) below RUNTIME CONFIG, with its own inline edit/save flow. The
   reference instead shows them, masked, inside the Runtime config section itself, and edits them
   inside the same Runtime config dialog used for provider/model/reasoning, under a collapsed
   "Advanced" disclosure — one edit surface per Agent, not two.

Per `AGENTS.md`'s "the reference is the shipped binary 1.0.32, not any npm release," both gaps
were checked against the Raft Computer 1.0.32 daemon bundle (recovery and citation conventions in
`docs/agents/reference-cli-research.md`) and, for the web layout, an extracted 1.0.32 web bundle
chunk observed directly by the task author.

## Decision

**Skill entry fields** (`packages/coforge-sdk/proto/coforge/rpc/v1/agent_skills.proto`'s
`AgentSkillMetadata`, additive `display_name` = 4, `bool user_invocable` = 5):

- `name` is always the skill's directory name (`SKILL.md` case) or the flat command file's
  basename minus `.md` — never the frontmatter `name:`. This is what a `/name` badge shows.
- `displayName` is the frontmatter `name:` when it is a non-empty string, else falls back to
  `name`.
- `userInvocable` is true when frontmatter `user-invocable` is the boolean `true` or the string
  `"true"` (CoForge accepts both forms; the reference's own parser only string-compares
  `"true"` — see the Comparison section).
- `sourcePath` is the scanned root's label (e.g. `~/.claude/skills`, `.claude/skills`,
  `$CLAUDE_CONFIG_DIR/skills`), not a per-file path. Multiple skills found under the same root
  share one `sourcePath`.
- Entries are deduplicated by `name` within each scope (global, workspace independently),
  first-found root wins.
- `directories`/`status` stay on the wire as CoForge's own scan diagnostics (the reference has
  no equivalent); the web Skills UI (`apps/web/src/features/agents/agent-skills.tsx`) no longer
  renders them, matching the reference's card-only layout: heading `Skills (N)`; a single loading
  line; on any non-ready state, the reason plus a Retry button (no separate Refresh, no caveat
  paragraph); two groups "Global"/"Workspace" with an icon, label and `(count)`; within a group,
  entries grouped by `sourcePath` (path caption + count, then a card stack); each card shows
  `displayName` bold, a `/name` badge only when `userInvocable`, and `description` clamped to two
  lines.
- The daemon scanner (`packages/daemon/src/code-agent/agent-skills.ts`) computes these fields;
  provider root lists (Claude/Codex/Kiro/Pi/CoForge) are unchanged.

**Environment variables**: the standalone `agent-environment-editor.tsx` is deleted. In its
place:

- Read view: inside the Profile tab's RUNTIME CONFIG section, after the Runtime/Model/Reasoning
  facts (`agent-profile-tab.tsx`), owner-only, a sub-label "Environment variables" and one chip
  per variable (`KEY=••••••`, dots = `min(value.length, 8)`), each chip's tooltip title showing
  `KEY=value`. Empty map: italic muted "No environment variables". Non-owners see nothing — the
  underlying read stays owner-only (`agent-environment.server.ts`'s `AgentEnvironment.get`).
- Edit view: inside `AgentRuntimeConfigForm` (`agent-runtime-config-dialog.tsx`), a collapsed
  "Advanced" `Disclosure` (React Aria Components' native `Disclosure`/`DisclosurePanel`, closed by
  default) below the runtime fields. Rows are `[key input] = [value input] [remove button]`, an
  "Add variable" button (64-row cap), and a hint that runtime-owned keys come from Provider/Model
  above. Env rows are plain `name="envKey"`/`name="envValue"` inputs read back from `FormData` on
  submit (`parseAgentEnvironmentFromForm`, `agent-form.ts`); empty keys are dropped, the last
  duplicate key wins, and there is no client-side name-format validation (the server validates).
  Env changes contribute to the form's own dirty state (`agentEnvironmentRowsChanged`) alongside
  the runtime fields' dirty state; the same Save button commits both, calling `update` only when
  the runtime fields changed and `saveAgentEnvironment` only when the env map changed. The panel
  loads the current map once with TanStack Query (`agentEnvironmentQuery`, key
  `["agent-environment", agentId]`, `enabled: profile.ownedByCurrentUser`) and shares it between
  the read-view chips and the edit form's seed rows; while that query has not resolved yet the
  Advanced disclosure shows a loading line and Save stays disabled rather than seeding from an
  empty map.
- Server semantics are unchanged: `AgentEnvironment.save`'s stop → persist → start path, and the
  stopped-Agent deferred-save shortcut, stay exactly as ADR 0038 left them. Only the UI surface
  moved.

## Comparison with Raft Computer 1.0.32

Behaviour read from the shipped 1.0.32 daemon bundle (recovery steps and citation convention:
`docs/agents/reference-cli-research.md`); no code was copied.

- `parseSkillMd(dirName, content)` (daemon bundle, ~line 846487) builds
  `{ name: dirName, displayName: dirName, description: "", userInvocable: false }` and only
  overwrites `displayName`/`description`/`userInvocable` from frontmatter `name`/`description`/
  `user-invocable` lines — `name` itself is never touched by frontmatter. `userInvocable` is set
  with `value === "true"`, a strict string comparison; a YAML boolean `true` in frontmatter would
  not set it in the reference. CoForge's daemon scanner accepts both the boolean `true` and the
  string `"true"`, a deliberate superset, not a copy.
- `scanSkillsDir(dir)` (~line 846452) reads one level of `dir`: a subdirectory/symlink entry
  yields `<dir>/<entry>/SKILL.md` with `name = entry.name`; a `.md` file entry directly in `dir`
  yields `name = <file minus .md>`. Both set `skill.sourcePath = dir` — the scanned directory
  itself, confirming "containing scan directory, not the file." The reference applies this flat
  `.md` convention to every skill root, including `.claude/skills` itself; CoForge's scanner still
  requires `SKILL.md` structure under `.claude/skills` and only accepts flat `.md` files under its
  own `legacy: "commands"`/`legacy: "pi"` roots — a known, unchanged divergence, not part of this
  decision.
- `SKILL_PATHS` (~line 846298) and the `dedup`/`shorten` helpers inside `listSkills` (~line
  846380) match the field model above exactly: `dedup` keeps the first-seen skill per `name`
  (`Set`-based, insertion order = scan order) within one call (global or workspace, each scanned
  and deduplicated independently); `shorten` rewrites a `sourcePath` that starts with the runtime
  home to `"~" + rest`. Neither function does anything with per-directory scan status; the
  reference has no `directories`/`status` concept at all — CoForge's is its own addition, kept on
  the wire for its own diagnostics but no longer shown in the UI, matching the reference's UI.
- The Skills UI layout (heading, loading line, Retry-only error state, Global/Workspace groups
  with counts, path-grouped card stacks, `/name` badge only when invocable, two-line-clamped
  description) was observed directly by the task author in an extracted 1.0.32 web bundle chunk,
  `AgentDetailPanel-CW_VMZT6.js` (functions `uc` skill card, `pc` path group, `Fs` scope, `xc`
  skills section, `Gc` env var block), not independently re-derived in this ADR.
- The same web bundle's runtime-config edit form carries `envVarEntries`/`envVarsMode:"advanced"`
  props, matching the collapsed-by-default Advanced disclosure placement this ADR adopts; the
  masked-chip read view (`Gc`) lives inside the runtime config section, not as a separate page
  section, matching this ADR's read-view placement.

## Rejected alternative

Keep the standalone Environment editor and only add the Skills field/UI changes. Rejected: the
reference treats env vars as part of one Runtime config surface, not a separate section with its
own edit affordance; keeping two editors for what is functionally one "how this Agent launches"
concern would leave CoForge's UI permanently diverged from the reference for no remaining reason,
and the two edit flows (env-only save vs. runtime-only save) already shared no code worth
preserving.

## Consequences

- `AgentSkillMetadata`'s two new fields are additive; a daemon that has not been updated yet
  simply reports `displayName: ""`/`userInvocable: false` on the wire, which the SDK's decoder
  accepts (non-empty `displayName` is required by the encoder, so an old daemon's result would
  need updating in lockstep with the web UI's expectations — both ship in the same release train
  as the rest of the Computer/Daemon pair, so this is not a standalone compatibility concern).
- The Environment editor's own tests (none existed as a dedicated file) are gone with the
  component; `agent-environment.server.ts`'s existing test coverage (`agent-environment.test.ts`)
  is untouched since server semantics did not change.
- A future decision to widen flat-`.md` command discovery to every skill root (matching the
  reference exactly) is explicitly deferred, not decided here.

## Validation and rollback

Validated by `packages/coforge-sdk/src/internal/agent-skills.test.ts`,
`packages/daemon/test/agent-skills.test.ts` and `agent-skills-routing.test.ts`,
`apps/web/test/agent-skills-query.test.ts`, `agent-runtime-config-dialog.test.tsx`, and
`agent-profile-tab.test.tsx`, plus `mise run check`/`mise run build`. Rollback is reverting the
commit; the additive proto fields and the unchanged server-side env semantics mean no data
migration is involved.
