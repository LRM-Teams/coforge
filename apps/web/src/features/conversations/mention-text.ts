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
  /** A short profile description shown as the completion row's second line, trimmed. Empty
   * when the profile has none; the row renders no second line in that case. */
  description: string;
  /** The person's uploaded avatar image, when they have one. Agents never carry an avatar
   * image, so this is always absent for `kind: "agent"`. */
  avatarUrl?: string | null;
  /** How strongly the viewer has recently and repeatedly @-mentioned this candidate in this
   * conversation (see `mentionAffinityScores` on the server); 0 when the viewer never has.
   * Higher ranks first within a match tier. */
  mentionScore: number;
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
 * The best match tier for one candidate against a lower-cased query, or `undefined` when it
 * does not match at all. Lower is a better match: 0 exact, 1 a handle/label prefix, 2 a later
 * label word's prefix (e.g. a surname), 3 any other substring hit. Matching reads the handle,
 * the full label, and each whitespace-separated label word, all case-insensitively.
 */
function matchTier(item: Mentionable, lowerQuery: string): 0 | 1 | 2 | 3 | undefined {
  const lowerHandle = item.handle.toLowerCase();
  const lowerLabel = item.label.toLowerCase();
  if (lowerHandle === lowerQuery || lowerLabel === lowerQuery) return 0;
  if (lowerHandle.startsWith(lowerQuery) || lowerLabel.startsWith(lowerQuery)) return 1;
  const laterWords = lowerLabel.split(/\s+/).filter(Boolean).slice(1);
  if (laterWords.some((word) => word.startsWith(lowerQuery))) return 2;
  if (lowerHandle.includes(lowerQuery) || lowerLabel.includes(lowerQuery)) return 3;
  return undefined;
}

/**
 * Completion candidates for a query, ranked the way a fast channel-mention popup should read:
 * closer text matches first (see `matchTier`), then within a tier whoever the viewer has
 * mentioned most (`item.mentionScore`, higher first), then whoever spoke most recently in this
 * conversation (`recentHandles`, most-recent first), then alphabetically by label and by
 * handle. The empty query matches everyone at the same tier, so score, recency, and alphabetical
 * order alone decide the list. Capped by `limit`.
 */
export function filterMentionables(
  mentionables: readonly Mentionable[],
  query: string,
  options: { recentHandles?: readonly string[]; limit?: number } = {},
): Mentionable[] {
  const { recentHandles = [], limit = 8 } = options;
  const lowerQuery = query.toLowerCase();
  const recencyByHandle = new Map<string, number>();
  recentHandles.forEach((handle, index) => {
    const key = handle.replace(/^@+/, "").toLowerCase();
    if (!recencyByHandle.has(key)) recencyByHandle.set(key, index);
  });

  const ranked = mentionables
    .map((item) => {
      const tier = matchTier(item, lowerQuery);
      if (tier === undefined) return undefined;
      return { item, tier, recency: recencyByHandle.get(item.handle.toLowerCase()) };
    })
    .filter((entry) => entry !== undefined);

  ranked.sort((left, right) => {
    if (left.tier !== right.tier) return left.tier - right.tier;
    if (left.item.mentionScore !== right.item.mentionScore) {
      return right.item.mentionScore - left.item.mentionScore;
    }
    if (left.recency !== right.recency) {
      if (left.recency === undefined) return 1;
      if (right.recency === undefined) return -1;
      return left.recency - right.recency;
    }
    return (
      left.item.label.localeCompare(right.item.label) ||
      left.item.handle.localeCompare(right.item.handle)
    );
  });

  return ranked.slice(0, limit).map((entry) => entry.item);
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
