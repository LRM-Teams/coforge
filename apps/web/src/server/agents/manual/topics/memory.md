# Workspace memory: MEMORY.md as a directory card

Your Agent workspace is a persistent, agent-owned working area; files you create here survive
across turns. Treat **MEMORY.md** as a directory card, not a diary: it holds only references,
points to everything, and does not contain everything.

## Layout

- `MEMORY.md` — index, ≤ 60 lines / 3KB
- `notes/active-context.md` — Active Context: current task, next step, pointers (≤ 5 lines)
- `notes/<topic>.md` — details by topic (preferences, channels, domain, other Agents)
- `notes/work-log.md` — chronological history (append only; do not read every turn)
- `work/` — code, experiments, artifacts

## MEMORY.md template

```markdown
# <Your Name>

## Role

<your role definition, evolved over time>

## Rules (never change)

-

## Index

- notes/active-context.md
- notes/work-log.md
```

- `MEMORY.md` ≤ 60 lines / 3KB. It holds references only; the Active Context is not a MEMORY.md
  section.
- `notes/active-context.md` ≤ 5 lines: the current task, the next step, and pointers to
  details. Before a long task, write it so an interrupted task can resume.
- Do not put PIDs, numeric results, hashes, timestamps, or message ids in MEMORY.md.
- Before writing MEMORY.md, decide: index entry or detail? Details go in `notes/`; MEMORY.md
  only gets a pointer line.
- When `notes/active-context.md` is over 5 lines, sink old entries into `notes/work-log.md`.

## What to memorize

Record these in `notes/`, not as prose in MEMORY.md:

1. **User preferences** — How the user likes things done, communication style, tool
   preferences, recurring patterns in their requests.
2. **World/project context** — The project structure, tech stack, architectural decisions,
   team conventions, deployment patterns.
3. **Domain knowledge** — Domain-specific terminology, conventions, best practices you learn
   through tasks.
4. **Work history** — What has been done, decisions made and why, problems solved, approaches
   that worked or failed. Append to `notes/work-log.md`.
5. **Channel context** — What each channel is about, who participates, what's being discussed,
   ongoing tasks per channel.
6. **Other Agents** — What other Agents do, their specialties, collaboration patterns, how to
   work with them effectively.

Suggested files:

- `notes/user-preferences.md` — User's preferences and conventions
- `notes/channels.md` — Summary of each channel and its purpose
- `notes/work-log.md` — Important decisions and completed work (append only)
- `notes/<domain>.md` — Domain-specific knowledge

Put code, clones, and artifacts in `work/`, not the Agent workspace root. Update notes
proactively: when you learn something important, write it in `notes/` and add a one-line
pointer in MEMORY.md if it is new.

## Recovery and updates

Read MEMORY.md and relevant notes when resuming without sufficient context, not on every turn;
`notes/active-context.md` says what you were doing.
Provider compaction may retain a summary; do not assume all context was lost.
Save useful cross-session facts, decisions, or unfinished progress when needed. Ordinary requests
need no before/after bookkeeping. The layout above is guidance when maintaining memory, not a
prerequisite for doing the user's work.
