/**
 * One-time rename of existing usernames to the readable form the allocator now produces. The
 * runbook, with the order to run these in and how to go back, is
 * `docs/operations/staging/rename-usernames.md`.
 *
 *   bun run scripts/rename-usernames.ts                         dry run: print the plan, change nothing
 *   bun run scripts/rename-usernames.ts --apply --dump <file>   write the dump, then rename
 *   bun run scripts/rename-usernames.ts --verify                check the rules, change nothing
 *   bun run scripts/rename-usernames.ts --restore <file>        put a dump's usernames back
 *
 * Reads `DATABASE_URL` from the environment and nothing else, and says which database that is
 * (host, port, name; never the credentials) before it does anything. Every rule and every write
 * is in `src/server/auth/username-rename*.server.ts`; this file parses arguments and prints.
 */
import { parseArgs } from "node:util";
import { getDatabaseClient } from "#src/server/db/client.server";
import { describeDatabaseTarget } from "#src/server/db/database-target.server";
import type { UsernameRenameDump } from "#src/server/auth/username-rename-dump.server";
import {
  UsernameRenameDumpFile,
  describeFailedRename,
  readUsernameRenameDumpFile,
} from "#src/server/auth/username-rename-dump-file.server";
import {
  previewUsernameRenames,
  renameUsernames,
  restoreUsernames,
} from "#src/server/auth/username-rename.server";
import { findUsernameViolations } from "#src/server/auth/username-rename-violations.server";

const USAGE = `Usage: bun run scripts/rename-usernames.ts [--apply --dump <file> | --verify | --restore <file>]
  (no option)             dry run: print the plan and change nothing
  --apply --dump <file>   write the old values to <file>, then rename, all in one transaction
  --verify                check the rules on the whole database and change nothing
  --restore <file>        put the usernames of a dump back`;

function usageError(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function readArguments() {
  try {
    const { values } = parseArgs({
      args: Bun.argv.slice(2),
      options: {
        apply: { type: "boolean" },
        verify: { type: "boolean" },
        dump: { type: "string" },
        restore: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    return values;
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
}

const { apply, verify, dump: dumpPath, restore: restorePath } = readArguments();
if ([apply, verify, restorePath !== undefined].filter(Boolean).length > 1)
  usageError("Use only one of --apply, --verify and --restore.");
if (apply && !dumpPath) usageError("--apply needs --dump <file>, the file the old values go to.");
if (dumpPath && !apply) usageError("--dump goes with --apply.");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
const target = describeDatabaseTarget(connectionString);
console.log(`database: ${target}`);
if (target === "(unparseable URL)") {
  console.error("DATABASE_URL is not a URL this script can read, so nothing was done.");
  process.exit(1);
}
const db = getDatabaseClient()!;

function rowCounts({ rows }: UsernameRenameDump) {
  return [
    `message_mentions ${rows.messageMentions.length}`,
    `task_history_events ${rows.taskHistoryEvents.length} (actor) + ${rows.taskHistoryPayloads.length} (title)`,
    `pending_mention_actions ${rows.pendingMentionActions.length}`,
    `reminders ${rows.reminders.length}`,
  ].join(", ");
}

try {
  if (verify) {
    const violations = await findUsernameViolations(db);
    if (!violations.length) console.log("no violations");
    for (const violation of violations) console.log(`${violation.rule}: ${violation.detail}`);
    process.exitCode = violations.length ? 1 : 0;
  } else if (restorePath) {
    const dump = await readUsernameRenameDumpFile(restorePath);
    await restoreUsernames(db, dump);
    console.log(`${dump.renames.length} users restored from ${restorePath}`);
  } else if (apply && dumpPath) {
    const file = new UsernameRenameDumpFile(dumpPath);
    let written: UsernameRenameDump | undefined;
    try {
      const plan = await renameUsernames(db, async (dump) => {
        await file.write(dump);
        written = dump;
      });
      if (!written) console.log("nothing to rename");
      else {
        console.log(`${plan.length} users renamed; rows changed: ${rowCounts(written)}`);
        console.log(`dump: ${dumpPath}`);
      }
    } catch (error) {
      // The rename rolled back: the dump describes a rename that never happened, so it is set
      // aside where a restore will not be pointed at it by mistake, and the failure reported
      // whole, whatever became of the dump.
      throw new Error(await describeFailedRename(file, error));
    }
  } else {
    const { userCount, plan, dump } = await previewUsernameRenames(db);
    for (const rename of plan)
      console.log(`${rename.userId}  ${rename.from} → ${rename.to}  (${rename.source})`);
    console.log(
      plan.length
        ? `dry run: ${plan.length} of ${userCount} users would be renamed; rows that would change: ${rowCounts(dump)}`
        : `dry run: nothing to rename (${userCount} users)`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
