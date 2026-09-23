/**
 * Pure text logic for the composer's reference completion, free of React and DOM types: which
 * in-progress `@handle` or `#channel` token sits at the caret, which channels a `#query` offers,
 * and how a chosen reference is spliced into the draft. Mention ranking lives next to the
 * mention grammar in `mention-text.ts`; the send-time recognizer (`lib/message-references.ts`)
 * turns the inserted plain text into structured tokens, so completion only ever writes text.
 */

/** The character that opened a completion: `@` for a mention, `#` for a channel. */
export type ReferenceTrigger = "@" | "#";

/** One channel the `#` list can offer: the messages layout's every-channel list (archived and
 * closed ones included), with the description shown as the row's second line. */
export type ChannelSuggestion = {
  id: string;
  name: string;
  description: string;
  archived: boolean;
};

/**
 * Whether text ending at the caret is inside code, in the grammar `splitCodeSpans` applies to a
 * sent body (fenced blocks first, then single-line inline spans), read on a draft that may still
 * be open: an odd number of ``` fences means an unclosed block, and otherwise an odd number of
 * backticks on the caret's line after the last fence means an unclosed inline span. A reference
 * is never recognized inside code, so completion does not open there.
 */
function caretInCode(beforeCaret: string): boolean {
  const fences = beforeCaret.split("```");
  if (fences.length % 2 === 0) return true;
  const afterLastFence = fences[fences.length - 1];
  const line = afterLastFence.slice(afterLastFence.lastIndexOf("\n") + 1);
  return line.split("`").length % 2 === 0;
}

/**
 * The completion query at the caret: the in-progress token starts at `@` or `#` (at the text
 * start or after whitespace) and runs to the caret using handle/channel-name characters only.
 * Returns the trigger, the token's start offset (the trigger itself) and the typed query without
 * it. `undefined` when the caret is not inside such a token — e.g. after another word, inside an
 * email address, past a completed reference followed by more name characters, or in code.
 *
 * The boundary is deliberately the strict one (Slack's and Discord's) for both triggers: the
 * popup opens only at the start of a word, never against the end of one. A looser boundary
 * (which would also fire straight after CJK text) was tried for task #64 and rejected — align
 * with the convention rather than inventing a house rule. The send-time recognizer is looser for
 * `#` (`去#random` still links); completion only decides when to offer help.
 */
export function activeReferenceQuery(
  value: string,
  caret: number,
): { trigger: ReferenceTrigger; start: number; query: string } | undefined {
  const beforeCaret = value.slice(0, caret);
  const match = /(?:^|\s)([@#])([a-z0-9_-]*)$/.exec(beforeCaret);
  if (!match || caretInCode(beforeCaret)) return undefined;
  const trigger: ReferenceTrigger = match[1] === "#" ? "#" : "@";
  const query = match[2];
  return { trigger, start: caret - query.length - 1, query };
}

/**
 * The channels a `#query` offers: every channel whose name contains the query
 * (case-insensitively), the current conversation's channel first when it matches, then the rest
 * alphabetically by name. Archived channels stay in the list; the row marks them. Capped by
 * `limit`.
 */
export function filterChannelSuggestions(
  channels: readonly ChannelSuggestion[],
  query: string,
  options: { currentChannelId?: string; limit?: number } = {},
): ChannelSuggestion[] {
  const { currentChannelId, limit = 8 } = options;
  const lowerQuery = query.toLowerCase();
  return channels
    .filter((channel) => channel.name.toLowerCase().includes(lowerQuery))
    .sort(
      (left, right) =>
        Number(right.id === currentChannelId) - Number(left.id === currentChannelId) ||
        left.name.localeCompare(right.name),
    )
    .slice(0, limit);
}

/**
 * Replace the in-progress token `[start, caret)` with `text` and a trailing space, and return the
 * new value and caret position (after the space, which keeps a completed reference from
 * re-opening the completion).
 */
export function insertReference(
  value: string,
  start: number,
  caret: number,
  text: string,
): { value: string; caret: number } {
  const inserted = `${text} `;
  const next = value.slice(0, start) + inserted + value.slice(caret);
  return { value: next, caret: start + inserted.length };
}
