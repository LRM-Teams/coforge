import type { Prisma } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { RENAME_DUMP_FORMAT, type UsernameRenameDump } from "./username-rename-dump.server";
import type { RenameCandidate, UsernameRename } from "./username-rename-plan.server";
import { renameHistoryTitleMentions } from "./username-rename-text.server";

/**
 * Where a username is stored, for the one-time rename of existing usernames
 * (`scripts/rename-usernames.ts`, `docs/operations/staging/rename-usernames.md`). A username is
 * copied into other rows when they are written: those copies are what an Agent reads back as
 * `@handle`, so a rename that changed only `users.username` would leave every earlier mention,
 * history record and reminder naming someone who no longer exists.
 *
 * The copies, and why each is rewritten:
 * - `message_mentions.handle` (people): how a stored `<@human:id>` token reads to an Agent.
 * - `task_history_events.actorName` (people): the actor's handle when the event was recorded.
 * - `task_history_events.payload` of a title change (`changes.title.from` and `.to`): the title as
 *   an Agent reads it, with each mention as `@handle` text. Free text names whoever the reader
 *   takes it for, so it is rewritten only where `@old` can only mean the renamed person: in the
 *   Workspaces they belong to, except one where a live Agent has that name. The rows rewritten
 *   are listed in the dump, and a restore writes those back by id and touches no other title.
 * - `pending_mention_actions.targetHandle` (people): the handle the strip offers Notify/Add for.
 * - `reminders.target` (`@username`, `@username:<thread>`): where an Agent's reminder points.
 */

/** Every read and write takes a transaction client, so a caller decides the boundary. */
export type RenameDb = Prisma.TransactionClient;

/** Everyone the rename plans over: their names, and the live Agent names of their Workspaces. */
export async function readRenameCandidates(db: RenameDb): Promise<RenameCandidate[]> {
  const [users, memberships, agents] = await Promise.all([
    db.user.findMany({
      select: {
        id: true,
        username: true,
        email: true,
        fullName: true,
        displayName: true,
        createdAt: true,
      },
    }),
    db.workspaceMembership.findMany({ select: { userId: true, workspaceId: true } }),
    db.agent.findMany({ where: ACTIVE_AGENT_WHERE, select: { workspaceId: true, name: true } }),
  ]);
  const agentNamesByWorkspace = new Map<string, string[]>();
  for (const { workspaceId, name } of agents)
    agentNamesByWorkspace.set(workspaceId, [
      ...(agentNamesByWorkspace.get(workspaceId) ?? []),
      name,
    ]);
  const agentNamesByUser = new Map<string, Set<string>>();
  for (const { userId, workspaceId } of memberships) {
    const names = agentNamesByUser.get(userId) ?? new Set<string>();
    for (const name of agentNamesByWorkspace.get(workspaceId) ?? []) names.add(name);
    agentNamesByUser.set(userId, names);
  }
  return users.map((user) => ({ ...user, agentNames: [...(agentNamesByUser.get(user.id) ?? [])] }));
}

const byName = (plan: readonly UsernameRename[]) =>
  new Map(plan.map((rename) => [rename.from, rename.to]));

/**
 * Reminders that point at one of `renamed`'s people by `@username`, or at a thread of their
 * conversation, with the target they would have under the new name.
 */
export async function remindersNaming(db: RenameDb, renamed: ReadonlyMap<string, string>) {
  const rows = await db.reminder.findMany({
    where: { target: { startsWith: "@" } },
    select: { id: true, target: true },
  });
  return rows.flatMap((row) => {
    const [handle, ...thread] = row.target.slice(1).split(":");
    const to = renamed.get(handle!);
    return to
      ? [{ id: row.id, target: row.target, renamedTarget: [`@${to}`, ...thread].join(":") }]
      : [];
  });
}

/**
 * The renames that apply to free text in each Workspace: those of the people who belong to it,
 * unless a live Agent of it has the person's old name, which `@old` may then mean.
 */
async function titleRenamesByWorkspace(db: RenameDb, plan: readonly UsernameRename[]) {
  const [memberships, agents] = await Promise.all([
    db.workspaceMembership.findMany({
      where: { userId: { in: plan.map((rename) => rename.userId) } },
      select: { userId: true, workspaceId: true },
    }),
    db.agent.findMany({
      where: { ...ACTIVE_AGENT_WHERE, name: { in: plan.map((rename) => rename.from) } },
      select: { workspaceId: true, name: true },
    }),
  ]);
  const agentNamed = new Set(agents.map((agent) => `${agent.workspaceId}/${agent.name}`));
  const renameOf = new Map(plan.map((rename) => [rename.userId, rename]));
  const byWorkspace = new Map<string, Map<string, string>>();
  for (const { userId, workspaceId } of memberships) {
    const rename = renameOf.get(userId)!;
    if (agentNamed.has(`${workspaceId}/${rename.from}`)) continue;
    const renamed = byWorkspace.get(workspaceId) ?? new Map<string, string>();
    renamed.set(rename.from, rename.to);
    byWorkspace.set(workspaceId, renamed);
  }
  return byWorkspace;
}

/**
 * Title changes in task history that name one of the plan's people as `@handle` text where that
 * can only be them (see `titleRenamesByWorkspace`), with the payload they would have under the new
 * names.
 */
export async function historyTitlesNaming(db: RenameDb, plan: readonly UsernameRename[]) {
  const byWorkspace = await titleRenamesByWorkspace(db, plan);
  if (!byWorkspace.size) return [];
  const rows = await db.taskHistoryEvent.findMany({
    where: { eventType: "amended", task: { workspaceId: { in: [...byWorkspace.keys()] } } },
    select: { id: true, payload: true, task: { select: { workspaceId: true } } },
  });
  return rows.flatMap((row) => {
    const renamedPayload = renameHistoryTitleMentions(
      row.payload,
      byWorkspace.get(row.task.workspaceId)!,
    );
    return renamedPayload ? [{ id: row.id, payload: row.payload, renamedPayload }] : [];
  });
}

/** What the plan would change, as the values there are now: the way back. */
export async function collectRenameDump(
  db: RenameDb,
  plan: readonly UsernameRename[],
): Promise<UsernameRenameDump> {
  const userIds = plan.map((rename) => rename.userId);
  const oldNames = plan.map((rename) => rename.from);
  const [
    users,
    messageMentions,
    taskHistoryEvents,
    taskHistoryPayloads,
    pendingMentionActions,
    reminders,
  ] = await Promise.all([
    db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } }),
    db.messageMention.findMany({
      where: { kind: "user", actorId: { in: userIds } },
      select: { messageId: true, memberId: true, handle: true },
    }),
    db.taskHistoryEvent.findMany({
      where: { actorType: "user", actorName: { in: oldNames } },
      select: { id: true, actorName: true },
    }),
    historyTitlesNaming(db, plan),
    db.pendingMentionAction.findMany({
      where: { targetUserId: { in: userIds } },
      select: { id: true, targetHandle: true },
    }),
    remindersNaming(db, byName(plan)),
  ]);
  return {
    format: RENAME_DUMP_FORMAT,
    createdAt: new Date().toISOString(),
    renames: [...plan],
    rows: {
      users,
      messageMentions,
      taskHistoryEvents: taskHistoryEvents.flatMap((row) =>
        row.actorName === null ? [] : [{ id: row.id, actorName: row.actorName }],
      ),
      taskHistoryPayloads: taskHistoryPayloads.map(({ id, payload }) => ({ id, payload })),
      pendingMentionActions,
      reminders: reminders.map(({ id, target }) => ({ id, target })),
    },
  };
}

/**
 * Renames the users and rewrites every copy of their username but the free text of titles: their
 * mentions, history actors, pending mentions and reminders. It is what a restore runs the other
 * way, because those copies follow the person by their id or their exact name.
 */
export async function renameUsernameCopies(
  db: RenameDb,
  plan: readonly UsernameRename[],
): Promise<void> {
  const reminders = await remindersNaming(db, byName(plan));
  for (const { userId, from, to } of plan) {
    await db.user.update({ where: { id: userId }, data: { username: to } });
    await db.messageMention.updateMany({
      where: { kind: "user", actorId: userId },
      data: { handle: to },
    });
    await db.taskHistoryEvent.updateMany({
      where: { actorType: "user", actorName: from },
      data: { actorName: to },
    });
    await db.pendingMentionAction.updateMany({
      where: { targetUserId: userId },
      data: { targetHandle: to },
    });
  }
  for (const { id, renamedTarget } of reminders)
    await db.reminder.update({ where: { id }, data: { target: renamedTarget } });
}

/**
 * The whole rename: the copies above, and the mentions in title changes where they can only mean
 * the renamed person. No new name is any account's current one (see `planUsernameRenames`), so
 * the order of these updates does not matter.
 */
export async function applyUsernameRenames(
  db: RenameDb,
  plan: readonly UsernameRename[],
): Promise<void> {
  const titles = await historyTitlesNaming(db, plan);
  await renameUsernameCopies(db, plan);
  for (const { id, renamedPayload } of titles)
    await db.taskHistoryEvent.update({
      where: { id },
      data: { payload: renamedPayload as Prisma.InputJsonObject },
    });
}

/** Writes the dumped title payloads back by id; a row that is gone is skipped. */
export async function restoreHistoryTitles(
  db: RenameDb,
  rows: UsernameRenameDump["rows"]["taskHistoryPayloads"],
): Promise<void> {
  for (const { id, payload } of rows)
    await db.taskHistoryEvent.updateMany({
      where: { id },
      data: { payload: payload as Prisma.InputJsonObject },
    });
}
