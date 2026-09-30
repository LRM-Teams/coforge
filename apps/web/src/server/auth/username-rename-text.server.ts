import { MENTION_PATTERN } from "@lrm/coforge-sdk/internal";

/**
 * A username as text: a task's history keeps its title as an Agent reads it (`agentReadableBody`,
 * `task-history.server.ts`), so every mention in it is `@handle`. A mention is what the grammar's
 * `MENTION_PATTERN` reads, which is what keeps `@old-x`, `@older` and `me@old` from being one.
 * A title is one line, so a code span is not treated apart.
 */

/** `text` with each mention of a name in `renamed` written with its new name. */
export function renameMentionsInText(text: string, renamed: ReadonlyMap<string, string>): string {
  return text.replace(MENTION_PATTERN, (mention, handle: string) => {
    const to = renamed.get(handle);
    return to === undefined ? mention : `@${to}`;
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The payload of a history event with the mentions in its title change (`changes.title.from` and
 * `.to`) rewritten, or undefined when that changes nothing. Other events' payloads hold statuses
 * and ids, and a description is stored as written, not as an Agent reads it.
 */
export function renameHistoryTitleMentions(
  payload: unknown,
  renamed: ReadonlyMap<string, string>,
): Record<string, unknown> | undefined {
  if (!isRecord(payload) || !isRecord(payload.changes) || !isRecord(payload.changes.title))
    return undefined;
  const { title } = payload.changes;
  const rewrite = (value: unknown) =>
    typeof value === "string" ? renameMentionsInText(value, renamed) : value;
  const [from, to] = [rewrite(title.from), rewrite(title.to)];
  if (from === title.from && to === title.to) return undefined;
  return {
    ...payload,
    changes: { ...payload.changes, title: { ...title, from, to } },
  };
}
