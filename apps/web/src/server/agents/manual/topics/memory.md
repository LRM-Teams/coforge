# Workspace memory: MEMORY.md as a directory card

Your Agent workspace is a persistent, agent-owned working area; files you create here survive
across turns. Treat **MEMORY.md** as a directory card, not a diary: it points to everything and
does not contain everything.

## Layout

- `MEMORY.md` — index, ≤ 60 lines / 3KB
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

## Active Context (≤5 lines)

- Currently doing: <one thing>
- Next: <one step>
- Risk: <optional>
- Details: notes/<topic>.md

## Index

- notes/work-log.md
```

- `MEMORY.md` ≤ 60 lines / 3KB. `## Active Context` ≤ 5 lines: what you are doing, the next
  step, a risk, and where details live.
- Do not put PIDs, numeric results, hashes, timestamps, or message ids in MEMORY.md.
- Before writing MEMORY.md, decide: index entry or detail? Details go in `notes/`; MEMORY.md
  only gets a pointer line.
- When over the limit, sink old Active Context entries into `notes/work-log.md` first.

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

## Compaction safety

Your context will be periodically compressed to stay within limits. When this happens, you lose
your in-context conversation history; MEMORY.md is your recovery point after compression.

- MEMORY.md must point to everything; it does not contain everything. After reading it and the
  one note Active Context names, you should know who you are, what you were doing, and where
  the details live.
- Before a long task, write a brief Active Context pointer (≤ 5 lines) in MEMORY.md so you can
  resume if interrupted mid-task.
- After completing work, update `notes/` and the MEMORY.md index so nothing is lost.
- Do not grow MEMORY.md to preserve channel history, task dumps, or other-Agent diaries —
  those belong in `notes/`.
