/**
 * Structured task references — the stored-body form of a `task #N` mention, in the same spirit
 * as the embedded mention token (`<@human:uuid>` / `<@agent:uuid>`, see `mentions.ts`).
 *
 * Two tiers, both checked against the conversation's own tasks so a number that names no real task
 * stays ordinary text:
 * - a typed `task #68` is resolved by the server at send time and stored as a token (`<@task:68>`);
 * - a bare `#68` (`BARE_TASK_REFERENCE_PATTERN`) is matched at render time against the
 *   conversation's task numbers, as Raft does, which also covers bodies written before the token.
 * Translation back happens at the edges: the browser draws a chip, and every plain-text reader (an
 * Agent-facing body, a copy, a list preview) reads `task #N` or the bare `#N` — never the raw token.
 */
import { splitCodeSpans } from "./mentions";

/**
 * The prose form a writer types: `task #68`, case-insensitive, whole-word `task` (so `mytask #5`
 * is not a reference) and the number not a prefix of a longer one (so `#680` is left alone). A
 * bare `#68` is not tokenized here: it is resolved at render time (`BARE_TASK_REFERENCE_PATTERN`).
 */
export const TASK_REFERENCE_PATTERN = /(?<![A-Za-z0-9_])task #(\d+)(?![0-9])/gi;

/**
 * A bare `#N` that may name a task, with Raft's boundaries: not after a word character or `/` (so
 * `word#5` and `issues/#5` stay prose), no leading zero, and a word boundary after the number (so
 * `#5a` is not `#5`). A match is a task reference only when N is one of the conversation's tasks;
 * any other `#N` (a PR or issue number) stays prose.
 */
export const BARE_TASK_REFERENCE_PATTERN = /(?<![\w/])#([1-9]\d*)\b/g;

/** The stored-body token for one resolved task reference: `<@task:68>`. */
export const TASK_REFERENCE_TOKEN_PATTERN = /<@task:(\d+)>/gi;

/** The stored-body token for one task number. */
export function taskReferenceToken(number: number): string {
  return `<@task:${number}>`;
}

/**
 * The task numbers a body references in prose, outside code spans, deduped in first-seen order.
 * A caller uses these to look up which numbers name a real task before deciding what to store.
 */
export function taskReferenceNumbers(body: string): number[] {
  const numbers = new Set<number>();
  for (const segment of splitCodeSpans(body)) {
    if (segment.code) continue;
    for (const match of segment.text.matchAll(new RegExp(TASK_REFERENCE_PATTERN.source, "gi")))
      numbers.add(Number(match[1]));
  }
  return [...numbers];
}

/**
 * Rewrites every `task #N` outside code spans whose number `knows` — a real task of this
 * conversation — into its token, and returns the rewritten body plus the referenced numbers in
 * first-seen order. A number that names no task is left byte-for-byte as written: a reference is
 * only a reference when it resolves, which is what keeps `task #999` ordinary prose.
 */
export function resolveTaskReferences(
  body: string,
  knows: (number: number) => boolean,
): { body: string; references: number[] } {
  const references: number[] = [];
  const seen = new Set<number>();
  const next = splitCodeSpans(body)
    .map((segment) => {
      if (segment.code) return segment.text;
      return segment.text.replace(
        new RegExp(TASK_REFERENCE_PATTERN.source, "gi"),
        (match, digits: string) => {
          const number = Number(digits);
          if (!knows(number)) return match;
          if (!seen.has(number)) {
            seen.add(number);
            references.push(number);
          }
          return taskReferenceToken(number);
        },
      );
    })
    .join("");
  return { body: next, references };
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
    new RegExp(TASK_REFERENCE_TOKEN_PATTERN.source, "gi"),
    (token, digits: string) => resolve(Number(digits)) ?? token,
  );
}
