# ADR 0060: WeeklyReportAssistant uses one Agent session per Records subject

Status: accepted
Date: 2026-09-21
Amends: [ADR 0009](0009-workspace-records-weekly-reports.md) (assistant identity);
  cloud Agent-session selection in [`architecture.md`](../architecture.md)
  (2026-09-08 session reference loop) for the WeeklyReportAssistant only

## Context

Each User has at most one [WeeklyReportAssistant](../architecture.md) Agent per
Workspace. That single Agent handles every week node: Leader overview parents,
member reports, format documents, Collect synthesizer wakes, key-point
extraction, and side-chat turns.

Side chat already scopes **UI threads** per page subject
(`WeeklyReportAssistantChatSession` on `report:<id>` / `cycle:<id>`). The
**Agent session** (provider-native transcript the runtime resumes) did not:
Daemon kept resuming one long-lived `.pi-sessions` / CoForge session for the
Agent. History from W38 collect/body-edit and W39 team key points piled into
the same context (hundreds of thousands of tokens), so key-point runs stalled
in `generating` after wasted deliberation and never called
`weekly-report-key-points submit`.

The weekly-report skill already tells the assistant that each right-panel page
is an independent subject. Runtime session binding must match that product
rule.

## Decision

1. **Scope**: Only the WeeklyReportAssistant. Ordinary Agents keep one
   recoverable Agent session association per Agent (existing cloud selection /
   resume rules unchanged).
2. **Binding key**: The Records page subject already carried on assistant
   wakes — `report:<weeklyReportId>` or `cycle:<cycleId>`. That key selects the
   Agent session used for launch/resume on that wake.
3. **Reuse**: Repeated wakes for the same subject reuse that subject's Agent
   session. Opening a different week node or report uses a different Agent
   session; it must not load another subject's transcript.
4. **Side chat vs runtime**: `WeeklyReportAssistantChatSession` remains the
   human-visible DM thread per subject. The subject → Agent-session map is a
   separate association used at launch/resume. Both key off the same subject;
   neither substitutes for the other.
5. **Durable memory**: Cross-subject identity and standing knowledge stay in
   the Agent workspace (`MEMORY.md` and skills). Week-specific work must not
   depend on one shared multi-week transcript.
6. **Concurrency**: Prefer serializing wakes on one WeeklyReportAssistant
   (finish or stop the current subject runtime before starting another). Do not
   silently merge two subjects into one process/session.
7. **Retention**: Old subject Agent-session files may be garbage-collected
   (e.g. keep recent cycles only). Missing mapping → create a fresh Agent
   session for that subject; do not resurrect an unrelated long session.
8. **Out of scope here**: Model deliberation loops; applying per-subject
   sessions to every Agent; schema changes beyond what implementation needs
   (any new table/column still needs the usual gate).

## Rejected alternatives

- **Keep one Agent session + rely on compaction**: Rejected; compaction did not
  prevent unbounded growth or stuck key-point runs in practice.
- **One Agent session per ISO week (cycle only)**: Rejected as the sole key;
  format pages, member reports, and overview parents on the same cycle still
  need isolation when the page subject differs. Cycle subject remains valid
  when the open page *is* a cycle.
- **Per-subject sessions for all Agents**: Deferred; larger product and control
  change than the weekly-report failure mode requires.
- **New Agent per week node**: Rejected; assistant identity stays one
  `(workspaceId, userId)` binding (ADR 0009 / assistants table).

## Consequences

- Wake paths (key points, Collect synthesizer, side-chat / platformTurn) must
  pass the page subject through to session selection before launch/resume.
- Cloud must not treat WeeklyReportAssistant's sole `currentSessionId` as the
  only resume target for every wake; subject mapping wins for that Agent kind.
- Operators / migration: existing oversized single sessions are abandoned for
  new subject keys (fresh sessions), not split in place.
- Follow-up implementation lives on branch work after this record; tests must
  lock same-subject reuse and cross-subject isolation.

## Validation

- Same overview report: two team key-point starts resume the same Agent session id.
- Different overview reports (e.g. W38 vs W39): distinct Agent session ids; the
  second does not contain the first's transcript.
- Side-chat subject A does not change runtime session selection for subject B.
- Rollback: stop selecting by subject and resume prior single-session behavior
  for the assistant (mapping unused); no wire-protocol change required by this
  decision alone.
