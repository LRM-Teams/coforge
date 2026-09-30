import { z } from "zod";
import { RENAME_SOURCES, type UsernameRename } from "./username-rename-plan.server";

/**
 * The file a rename writes before it changes anything: the old value of every row it will change,
 * with the key to find it again, and the renames themselves. A restore runs those renames the
 * other way (`username-rename.server.ts`); the rows are the record of exactly what was there. It
 * holds no email or other profile data.
 */

export const RENAME_DUMP_FORMAT = "coforge-username-rename-dump/1";

export type UsernameRenameDump = {
  format: typeof RENAME_DUMP_FORMAT;
  createdAt: string;
  renames: UsernameRename[];
  rows: {
    users: { id: string; username: string }[];
    messageMentions: { messageId: string; memberId: string; handle: string }[];
    taskHistoryEvents: { id: string; actorName: string }[];
    taskHistoryPayloads: { id: string; payload: unknown }[];
    pendingMentionActions: { id: string; targetHandle: string }[];
    reminders: { id: string; target: string }[];
  };
};

const usernameRenameDumpSchema = z.object({
  format: z.literal(RENAME_DUMP_FORMAT),
  createdAt: z.string(),
  renames: z.array(
    z.object({
      userId: z.string(),
      from: z.string(),
      to: z.string(),
      source: z.enum(RENAME_SOURCES),
    }),
  ),
  rows: z.object({
    users: z.array(z.object({ id: z.string(), username: z.string() })),
    messageMentions: z.array(
      z.object({ messageId: z.string(), memberId: z.string(), handle: z.string() }),
    ),
    taskHistoryEvents: z.array(z.object({ id: z.string(), actorName: z.string() })),
    taskHistoryPayloads: z.array(z.object({ id: z.string(), payload: z.json() })),
    pendingMentionActions: z.array(z.object({ id: z.string(), targetHandle: z.string() })),
    reminders: z.array(z.object({ id: z.string(), target: z.string() })),
  }),
});

/** Reads a dump file's text, refusing anything this script did not write. */
export function parseUsernameRenameDump(text: string): UsernameRenameDump {
  return usernameRenameDumpSchema.parse(JSON.parse(text));
}

/** The dump as it is written to a file. */
export function serializeUsernameRenameDump(dump: UsernameRenameDump): string {
  return `${JSON.stringify(dump, null, 2)}\n`;
}
