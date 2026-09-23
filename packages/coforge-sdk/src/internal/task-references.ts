/**
 * Structured task references — the stored-body form of a task reference, in the same spirit as the
 * embedded mention token (`<@human:uuid>` / `<@agent:uuid>`, see `mentions.ts`).
 *
 * A writer types `task #68` or a bare `#68`; the server resolves either at send time (the Web
 * message-reference recognizer) against the conversation's own tasks and stores a token
 * (`<@task:68>`), so a number that names no task stays ordinary text. Only a token is ever a
 * reference: a body is never re-read for bare numbers when it is shown. Translation back happens at
 * the edges: the browser draws a chip, and every plain-text reader (an Agent-facing body, a copy, a
 * list preview) reads `task #N` — never the raw token.
 */

/**
 * The prose form `task #68`: case-insensitive, whole-word `task` (so `mytask #5` is not this form)
 * and the number not a prefix of a longer one (so `#680` is left alone).
 */
export const TASK_REFERENCE_PATTERN = /(?<![A-Za-z0-9_])task #(\d+)(?![0-9])/gi;

/**
 * The prose form bare `#68`: not after a word character or `/` (so `word#5` and `issues/#5` stay
 * prose), no leading zero, and a word boundary after the number (so `#5a` is not `#5`). A match is a
 * task reference only when N is one of the conversation's tasks; any other `#N` (a PR or issue
 * number) is not a task.
 */
export const BARE_TASK_REFERENCE_PATTERN = /(?<![\w/])#([1-9]\d*)\b/g;

/** The stored-body token for one resolved task reference: `<@task:68>`. */
export const TASK_REFERENCE_TOKEN_PATTERN = /<@task:(\d+)>/gi;

/** The stored-body token for one task number. */
export function taskReferenceToken(number: number): string {
  return `<@task:${number}>`;
}

/**
 * Rewrites every task-reference token through `resolve`, leaving a token `resolve` does not know
 * byte-for-byte intact — the same contract as `replaceMentionTokens`, so a caller that lacks the
 * task rows degrades to the raw token rather than dropping the reference.
 */
export function replaceTaskReferenceTokens(
  body: string,
  resolve: (number: number) => string | undefined,
): string {
  return body.replace(
    TASK_REFERENCE_TOKEN_PATTERN,
    (token, digits: string) => resolve(Number(digits)) ?? token,
  );
}
