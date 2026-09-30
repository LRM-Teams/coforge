import type { PrismaClient } from "#src/generated/prisma/client";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import {
  applyUsernameRenames,
  collectRenameDump,
  readRenameCandidates,
  renameUsernameCopies,
  restoreHistoryTitles,
  type RenameDb,
} from "./username-rename-copies.repository.server";
import type { UsernameRenameDump } from "./username-rename-dump.server";
import { planUsernameRenames, type UsernameRename } from "./username-rename-plan.server";
import {
  UsernameRenameRejected,
  findUsernameViolations,
} from "./username-rename-violations.server";

/**
 * The one-time rename of existing usernames as three operations: preview it, apply it, restore it.
 * The rules are in `username-rename-plan.server.ts`, the copies it rewrites in
 * `username-rename-copies.repository.server.ts`, and what it checks in
 * `username-rename-violations.server.ts`.
 *
 * Deliberately not touched, because they are not copies of a username:
 * - the personal Workspace's slug, a URL that must keep working, and its name, which was built
 *   from the person's name at sign-up;
 * - an `@handle` still written as text in a message body (or a task description): the body is what
 *   the sender wrote, and a mention that resolved is a token that reads the current name.
 */

/** A whole rename is one interactive transaction, and it may touch a few thousand rows. */
const RENAME_TRANSACTION_TIMEOUT_MS = 10 * 60_000;

/** A rename that lost a name to an account created while it ran; nothing was changed. */
export class UsernameRenameCollision extends Error {
  constructor(usernames: readonly string[]) {
    super(
      `${usernames.map((name) => `@${name}`).join(", ")} ${usernames.length === 1 ? "was" : "were"} taken by another account while the rename ran, so nothing was changed. Run it again: the new plan works around the new account.`,
    );
    this.name = "UsernameRenameCollision";
  }
}

/** A dump that does not describe the database as it is now; nothing was changed. */
export class UsernameRestoreRefused extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `this dump cannot be restored, nothing was changed: ${problems.join("; ")}. A dump restores a rename that is still in place, as it was made.`,
    );
    this.name = "UsernameRestoreRefused";
  }
}

/** The plan and what it would change, read and not applied: the dry run. */
export async function previewUsernameRenames(db: RenameDb) {
  const candidates = await readRenameCandidates(db);
  const plan = planUsernameRenames(candidates);
  return { userCount: candidates.length, plan, dump: await collectRenameDump(db, plan) };
}

/**
 * Renames every user that needs it, in one transaction: plan, hand the dump to `writeDump`, apply,
 * and check the rules, rolling everything back if any is broken. Nothing is written, and no dump
 * is asked for, when there is nothing to rename.
 */
export async function renameUsernames(
  db: PrismaClient,
  writeDump: (dump: UsernameRenameDump) => Promise<void>,
): Promise<UsernameRename[]> {
  let plan: readonly UsernameRename[] = [];
  try {
    return await db.$transaction(
      async (tx) => {
        plan = planUsernameRenames(await readRenameCandidates(tx));
        if (!plan.length) return [];
        await writeDump(await collectRenameDump(tx, plan));
        await applyUsernameRenames(tx, plan);
        const violations = await findUsernameViolations(tx, plan);
        if (violations.length) throw new UsernameRenameRejected(violations);
        return [...plan];
      },
      { timeout: RENAME_TRANSACTION_TIMEOUT_MS },
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const taken = await takenBySomeoneElse(
      db,
      plan.map((rename) => rename.to),
      plan.map((rename) => rename.userId),
    );
    throw taken.length ? new UsernameRenameCollision(taken) : error;
  }
}

/** Which of `usernames` accounts other than `userIds` hold, read once the transaction is gone. */
async function takenBySomeoneElse(
  db: PrismaClient,
  usernames: readonly string[],
  userIds: readonly string[],
): Promise<string[]> {
  const rows = await db.user.findMany({
    where: { username: { in: [...usernames] }, id: { notIn: [...userIds] } },
    select: { username: true },
  });
  return rows.map((row) => row.username);
}

/**
 * Puts the old usernames back: the renames the dump lists, run the other way, so a copy written
 * since the rename under a new name follows its person back too, and the title payloads the dump
 * lists, by id. A title is free text and is never rewritten by name here: `@new` may be an Agent's,
 * so one written since the rename keeps what its writer wrote. It only restores a rename that is
 * still in place: every user in the dump must hold the name the rename gave them and no other
 * account may hold their old one, or nothing is changed and each mismatch is named. A dump left
 * by a rename that rolled back therefore restores nothing, whoever has taken its new names since.
 */
export async function restoreUsernames(db: PrismaClient, dump: UsernameRenameDump): Promise<void> {
  const reversed = dump.renames.map(({ userId, from, to, source }) => ({
    userId,
    from: to,
    to: from,
    source,
  }));
  try {
    await db.$transaction(
      async (tx) => {
        const problems = await restoreProblems(tx, dump.renames);
        if (problems.length) throw new UsernameRestoreRefused(problems);
        await renameUsernameCopies(tx, reversed);
        await restoreHistoryTitles(tx, dump.rows.taskHistoryPayloads);
      },
      { timeout: RENAME_TRANSACTION_TIMEOUT_MS },
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const taken = await takenBySomeoneElse(
      db,
      dump.renames.map((rename) => rename.from),
      dump.renames.map((rename) => rename.userId),
    );
    throw taken.length
      ? new UsernameRestoreRefused(
          taken.map((name) => `@${name} was taken by another account while the restore ran`),
        )
      : error;
  }
}

/** What stops a dump's renames being undone, one plain sentence each; empty when nothing does. */
async function restoreProblems(
  db: RenameDb,
  renames: readonly UsernameRename[],
): Promise<string[]> {
  const userIds = renames.map((rename) => rename.userId);
  const [users, holders] = await Promise.all([
    db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } }),
    db.user.findMany({
      where: { username: { in: renames.map((rename) => rename.from) }, id: { notIn: userIds } },
      select: { username: true },
    }),
  ]);
  const usernameById = new Map(users.map((user) => [user.id, user.username]));
  return [
    ...renames.flatMap(({ userId, from, to }) => {
      const current = usernameById.get(userId);
      if (current === undefined)
        return [`user ${userId}, called @${from} before the rename, no longer exists`];
      return current === to
        ? []
        : [`@${from} was renamed @${to}, but that account is @${current} now`];
    }),
    ...holders.map(
      ({ username }) => `@${username} cannot come back: it was taken by another account since`,
    ),
  ];
}
