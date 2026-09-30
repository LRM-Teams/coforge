import type { UsernameRename } from "./username-rename-plan.server";
import {
  historyTitlesNaming,
  remindersNaming,
  type RenameDb,
} from "./username-rename-copies.repository.server";

/** A rule a renamed database keeps, and the row that breaks it. */
export type UsernameViolation = {
  rule:
    | "duplicate-username"
    | "agent-name"
    | "stale-mention-handle"
    | "stale-pending-handle"
    | "stale-history-actor"
    | "stale-history-title"
    | "stale-reminder-target";
  detail: string;
};

/** A rename that broke a rule; its transaction is rolled back before this is thrown. */
export class UsernameRenameRejected extends Error {
  constructor(readonly violations: readonly UsernameViolation[]) {
    const shown = violations
      .slice(0, 10)
      .map((violation) => `${violation.rule}: ${violation.detail}`);
    const more =
      violations.length > shown.length ? [`... and ${violations.length - shown.length} more`] : [];
    super(
      `the rename broke ${violations.length} rule(s), nothing was changed: ${[...shown, ...more].join("; ")}`,
    );
    this.name = "UsernameRenameRejected";
  }
}

/**
 * The rules a renamed database keeps. The first four are checked on the whole database, so
 * `--verify` after the apply is the check the apply made before it committed. With the plan that
 * was applied, it also looks for an old name that history records and reminders still carry:
 * those cannot be told from a person who has since left without knowing the old names.
 */
export async function findUsernameViolations(
  db: RenameDb,
  plan: readonly UsernameRename[] = [],
): Promise<UsernameViolation[]> {
  const oldNames = plan.map((rename) => rename.from);
  const renamed = new Map(plan.map((rename) => [rename.from, rename.to]));
  const [
    duplicates,
    agentClashes,
    mentionDrift,
    pendingDrift,
    staleHistory,
    staleTitles,
    staleReminders,
  ] = await Promise.all([
    db.$queryRaw<{ username: string }[]>`
        SELECT "username" FROM "users" GROUP BY "username" HAVING COUNT(*) > 1`,
    db.$queryRaw<{ username: string; workspaceId: string }[]>`
        SELECT u."username", a."workspaceId"
          FROM "workspace_memberships" m
          JOIN "users" u ON u."id" = m."userId"
          JOIN "agents" a ON a."workspaceId" = m."workspaceId"
                         AND a."name" = u."username"
                         AND a."deletedAt" IS NULL`,
    db.$queryRaw<{ messageId: string; handle: string; username: string }[]>`
        SELECT mm."messageId", mm."handle", u."username"
          FROM "message_mentions" mm
          JOIN "users" u ON u."id" = mm."actorId"
         WHERE mm."kind" = 'user' AND mm."handle" <> u."username"`,
    db.$queryRaw<{ id: string; targetHandle: string; username: string }[]>`
        SELECT p."id", p."targetHandle", u."username"
          FROM "pending_mention_actions" p
          JOIN "users" u ON u."id" = p."targetUserId"
         WHERE p."targetHandle" <> u."username"`,
    oldNames.length
      ? db.taskHistoryEvent.findMany({
          where: { actorType: "user", actorName: { in: oldNames } },
          select: { id: true, actorName: true },
        })
      : [],
    oldNames.length ? historyTitlesNaming(db, plan) : [],
    oldNames.length ? remindersNaming(db, renamed) : [],
  ]);
  return [
    ...duplicates.map(({ username }) => ({
      rule: "duplicate-username" as const,
      detail: `${username} names more than one user`,
    })),
    ...agentClashes.map(({ username, workspaceId }) => ({
      rule: "agent-name" as const,
      detail: `${username} is a person and a live Agent in Workspace ${workspaceId}`,
    })),
    ...mentionDrift.map(({ messageId, handle, username }) => ({
      rule: "stale-mention-handle" as const,
      detail: `message ${messageId} mentions ${handle}, now ${username}`,
    })),
    ...pendingDrift.map(({ id, targetHandle, username }) => ({
      rule: "stale-pending-handle" as const,
      detail: `pending mention ${id} targets ${targetHandle}, now ${username}`,
    })),
    ...staleHistory.map(({ id, actorName }) => ({
      rule: "stale-history-actor" as const,
      detail: `task history event ${id} still names ${actorName}`,
    })),
    ...staleTitles.map(({ id }) => ({
      rule: "stale-history-title" as const,
      detail: `the title change of task history event ${id} still mentions an old username`,
    })),
    ...staleReminders.map(({ id, target }) => ({
      rule: "stale-reminder-target" as const,
      detail: `reminder ${id} still points at ${target}`,
    })),
  ];
}
