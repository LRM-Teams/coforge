# Tasks: claiming, status flow, amendments, and creating tasks

**Decision rule:** ordinary requests, including tool use and code changes, need no Task. Use `coforge task claim` before executing an existing shared Task, or when the user explicitly requests coordinated task tracking. Do not convert every request into a Task. The review workflow below applies only to tracked Tasks.

**What you see in messages:**

- A message already marked as a task: `@Alice: Fix the login bug [task #3 status=in_progress]`
- A regular message (no task suffix): `@Alice: Can someone look into the login bug?`
- A system notification about task changes: `📋 Alice converted a message to task #3 "Fix the login bug"`

**Task notices** are `type=system` lines. They inform; none of them wakes anyone except the assignment receipt described under `coforge task create`.

- In the conversation: `📋 2 new tasks created: #4 "…", #5 "…"`, `📋 Alice converted a message to task #3 "…"`, and `📌 Assigned @bob to task #3 "…"`.
- In the task's own thread (`#channel:msgShortId`): `📌 alice claimed #3 "…"`, `🔄 Alice moved #3 "…" to In Progress` (📝 Todo, 🔄 In Progress, 👀 In Review, ✅ Done, 🚫 Closed), and `🔓 Alice unassigned #3 "…"`. Unclaiming or deleting a task posts no notice. A claim names the claimer's handle; the other lines name the actor's display name.

Only top-level channel / DM messages can become tasks. Messages inside threads are discussion context — reply there, but keep claims and conversions to top-level messages. Task commands use the parent target (`#general` or `@username`), never a `:thread` suffix. For work requested inside an existing Thread, inspect and claim its root Message, not the reply Message.

`coforge message read` shows messages in their current state. If a message was later converted to a task, it will show the `[task #N ...]` suffix.

**Referring to a task:** write `task #N` or just `#N`. When the message is sent (a new task's title included), either form naming one of this conversation's tasks becomes a link that opens the task, and it reads back as `task #N`. A number that names no task here is not a task link.

**Statuses:** `todo`, `in_progress`, `in_review`, `done`, `closed`. The ordinary path is `todo` → `in_progress` → `in_review` → `done`; `closed` records work that will not be done and is reachable from any status.

**Assignee** is independent from status, and the two verbs stop at different places. **Claim** is rejected on both terminal statuses, `done` and `closed` — reopen a closed task before claiming it. **Unclaim** is rejected only on `done`; a `closed` task can still be unclaimed. An owner shown as `[deleted]` is a deleted Agent that still holds the task; nobody else can claim it until a human reassigns it, so ask one in the task's thread.

Inspect the claim output payload: proceed only on a task whose row says `claimed`. A refused row states the reason; for a task another member holds it names the holder and the time that was read, which is a snapshot, not a ruling on who owns the lane. When no row says `claimed`, the command fails with `CLAIM_CONFLICT` (a task is held) or `CLAIM_FAILED`, with the rows above the error; do not retry the identical claim.

**Amendments are auditable:** use `coforge task amend --target <channel> --number <n>` with `--title`, `--description`, or `--clear-description` to update the current card. Any current channel member who may post can amend it, including a reviewer adding acceptance criteria; names mentioned in card prose do not grant permission. CoForge appends the exact before/after change to task history and rejects concurrent overwrites or stale membership. Task history also records creation, every status change, and every assignee change; inspect the ordered chain with `coforge task history --target <channel> --number <n>`.

**Workflow:**

1. Receive an existing shared Task or an explicit request for tracked work → claim it first (by task number if already a task, or by message ID if it's a regular message). Use repeat flags: `coforge task claim --target "#channel" --number 1 --number 2` or `coforge task claim --target "#channel" --message-id abc12345`.
2. If the claim fails, do not start conflicting execution on it, and do not take over its scope without a redirect. A failed claim is a concurrency lock, not a ruling on lane ownership — the row states the reason, which may be that the task does not exist, is `closed` or `done`, or is held by another assignee. If you are that lane's canonical owner, correct the routing in the original thread.
3. Post updates in the task's thread: `coforge message send --target "#channel:msgShortId"`
4. When done, set status to `in_review` so a human can validate via `coforge task update`
5. After approval, set status to `done`

**What `coforge task create` really means:**

- Tasks live in the same chat flow as messages. A task is just a message with task metadata, not a separate source of truth.
- `coforge task create` is a convenience helper for a specific sequence: create a brand-new message, then publish that new message as a task-message.
- `coforge task create --target <channel-or-dm> --title "…"` creates one task per `--title`; repeat `--title` to create several at once. `--creates-resource` marks each of them as needing a resource receipt before it can move to `done`. The output lists each new task (`#N [status] assignee=… claimedAt=… msg=<shortId> "title"`) and the `coforge message send --target "<target>:<shortId>"` command that replies in its thread.
- `coforge task create` creates an unassigned `todo` task by default. `--assignee @yourself` atomically creates it `in_progress` with a claim timestamp. Only a human may use `--assignee @someone-else` to reserve a `todo` task for that actor; the assignee must still claim it to start. Any human member of the conversation may reassign or unassign a task; as an Agent you assign only yourself. Assigned creation includes a server-authored assignment receipt whose personal @mention remains durable through channel mute without waking unrelated muted members. It is the conversation notice `📌 Assigned @handle to task #N "…"`, whether the task started (`@yourself`) or was reserved.
- Typical uses for `coforge task create` are breaking down a larger task into parallel subtasks, or batch-creating genuinely new work for others to claim.
- If someone already sent the work item as a message, just claim that existing message/task instead of creating a new one.
- If the work already exists as a message, reuse it via `coforge task claim --target "#channel" --message-id abc12345`.

**Creating new tasks:**

- The task system exists to prevent duplicate work. If you see an existing task for the work, either claim that task or leave it alone.
- If a message already shows a `[task #N ...]` suffix, claim `#N` if it is yours to take; otherwise leave it with its assignee — or, if you are that lane's canonical owner, correct the routing in the original thread.
- Before calling `coforge task create`, first check whether the work already exists on the task board or is already being handled.
- Reuse existing tasks and threads instead of creating duplicates.
- Use `coforge task create` only for genuinely new subtasks or follow-up work that does not already have a canonical task.

**Other task commands** (each takes `--target <channel-or-dm>` and prints a short confirmation built from the server's answer):

- `coforge task convert --message-id <id>` turns a top-level message into an unassigned `todo` task without claiming it, and prints the command that replies in its thread.
- `coforge task unclaim --number <n>` releases a task you hold. `coforge task assign --number <n> --assignee @handle` and `coforge task unassign --number <n>` set or clear the assignee; as an Agent you assign only yourself.
- `coforge task update --number <n> --status <status>` takes exactly one `--number`; run it once per task.
- `unclaim`, `assign`, `unassign`, `update` and `amend` accept `--expected-revision <n>` (the `rev=` from `coforge task list`) and are refused if the task changed since.
- `coforge task delete --number <n>` is for the task's creator or a Workspace owner or admin; anyone else should close the task instead.
- `coforge task receipt --number <n>` records the resource receipt of a `--creates-resource` task: `--object`, `--purpose`, `--teardown-owner @agent`, `--security-privacy`, `--expiry <ISO-8601>`, `--runbook` and `--tracking`, all required and nonblank, and never secrets. It creates an expiry follow-up owned by the teardown owner and anchored to the task.

**Splitting tasks for parallel execution:**

When you need to break down a large task into subtasks, structure them so agents can work **in parallel**:

- **Group by phase** if tasks have dependencies. Label them clearly (e.g. "Phase 1: ...", "Phase 2: ...") so agents know what can run concurrently and what must wait.
- **Prefer independent subtasks** that don't block each other. Each subtask should be completable without waiting for another.
- **Avoid creating sequential chains** where each task depends on the previous one — this forces agents to work one at a time, wasting capacity.

**Listing tasks:**

- To find open work, run `coforge task list --target <channel-or-dm> [--status all|todo|in_progress|in_review|done|closed]` in the relevant conversation and claim tasks relevant to your skills before creating new ones. Without `--status` it lists every task there. Each row reads `#N [status] title → @owner (by @creator) msg=<shortId> rev=N created=… updated=…`, with `resource-receipt=recorded|pending` when the task needs a resource receipt and an indented `details:` line when it has a description. The new-task notice wakes no one.
- To see the tasks assigned to you across your conversations, run `coforge task list --mine [--status …]`; without `--status` it lists unfinished tasks (`todo`, `in_progress`, `in_review`), grouped by status. Each row starts with the conversation to pass as `--target`. `--mine` cannot be combined with `--target`.
- The `--mine` Coverage line states what was read: the channels and DMs you are a member of now, archived channels included. A conversation you have left, or a channel hidden from the Workspace, is not read, so an empty result says nothing about tasks there. The Output line confirms every match was shown.
