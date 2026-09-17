/**
 * Pure mention text logic for the conversation UI, free of React and DOM types: the message
 * body's segment splitting for stream highlight, and the composer's @-completion query
 * detection, filtering, and insertion. The grammar itself (`MENTION_TOKEN_PATTERN`,
 * `splitCodeSpans`) is the server's single definition in `@lrm/coforge-sdk/internal/mentions`,
 * so highlight and wake rules can never disagree about what counts as a mention. Rendering is
 * token-only by design (no legacy plain-`@handle` compatibility).
 */
import { MENTION_TOKEN_PATTERN, splitCodeSpans } from "@lrm/coforge-sdk/internal";

/** One resolved mention row as the browser message view carries it. */
export type MentionRef = { kind: "user" | "agent"; actorId: string; handle: string };

export type MentionSegment =
  | { kind: "text"; text: string }
  | {
      kind: "mention";
      /** The display text, always `@handle`. */
      text: string;
      handle: string;
    };

/**
 * Splits a message body into plain text and mention chips: every stored `<@human:uuid>`/
 * `<@agent:uuid>` token that resolves through the message's mention rows becomes a chip;
 * everything else — including pre-token plain `@handle` text and code spans — renders as
 * written. An unresolvable token degrades to its raw text rather than a phantom highlight.
 */
export function splitMentionSegments(
  body: string,
  mentions: readonly MentionRef[] = [],
): MentionSegment[] {
  const handleByToken = new Map(
    mentions.map((mention) => [`${mention.kind}:${mention.actorId.toLowerCase()}`, mention.handle]),
  );
  const segments: MentionSegment[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = segments.at(-1);
    if (last?.kind === "text") last.text += text;
    else segments.push({ kind: "text", text });
  };
  const tokenPattern = new RegExp(MENTION_TOKEN_PATTERN.source, "gi");
  for (const segment of splitCodeSpans(body)) {
    if (segment.code) {
      pushText(segment.text);
      continue;
    }
    let offset = 0;
    for (const match of segment.text.matchAll(tokenPattern)) {
      const key = `${match[1]!.toLowerCase() === "human" ? "user" : "agent"}:${match[2]!.toLowerCase()}`;
      const handle = handleByToken.get(key);
      pushText(segment.text.slice(offset, match.index));
      if (handle === undefined) pushText(match[0]);
      else segments.push({ kind: "mention", text: `@${handle}`, handle });
      offset = match.index + match[0].length;
    }
    pushText(segment.text.slice(offset));
  }
  return segments;
}

export type Mentionable = {
  kind: "user" | "agent";
  id: string;
  /** The handle inserted into the text and matched by `MENTION_PATTERN`. */
  handle: string;
  /** Human-facing label shown next to the handle in the completion list. */
  label: string;
};

/**
 * The @-completion query at the caret: the in-progress token starts at `@` (at the text start
 * or after whitespace) and runs to the caret using handle characters only. Returns the token's
 * start offset (the `@` itself) and the typed query without it. `undefined` when the caret is
 * not inside such a token — e.g. after a space, inside an email address, or past a completed
 * mention followed by more handle characters.
 */
export function activeMentionQuery(
  value: string,
  caret: number,
): { start: number; query: string } | undefined {
  const beforeCaret = value.slice(0, caret);
  const match = /(?:^|[\s])@([a-z0-9_-]*)$/.exec(beforeCaret);
  if (!match) return undefined;
  return { start: caret - match[1].length - 1, query: match[1] };
}

/**
 * Completion candidates for a query: handle prefix matches first, then label substring
 * matches, each group keeping the caller's (handle-sorted) order. The empty query lists
 * everyone, capped by `limit`.
 */
export function filterMentionables(
  mentionables: readonly Mentionable[],
  query: string,
  limit = 8,
): Mentionable[] {
  const handleMatches = mentionables.filter((item) => item.handle.startsWith(query));
  const lowerQuery = query.toLowerCase();
  const labelMatches = mentionables.filter(
    (item) => !item.handle.startsWith(query) && item.label.toLowerCase().includes(lowerQuery),
  );
  return [...handleMatches, ...labelMatches].slice(0, limit);
}

/**
 * Replace the in-progress token `[start, caret)` with `@handle ` and return the new value and
 * caret position (after the trailing space, which keeps a completed mention from re-opening
 * the completion).
 */
export function insertMention(
  value: string,
  start: number,
  caret: number,
  handle: string,
): { value: string; caret: number } {
  const inserted = `@${handle} `;
  const next = value.slice(0, start) + inserted + value.slice(caret);
  return { value: next, caret: start + inserted.length };
}
