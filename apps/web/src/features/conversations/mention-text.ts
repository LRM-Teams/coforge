/**
 * Pure mention text logic for the conversation UI, free of React and DOM types: the composer's
 * @-completion query detection, filtering, and insertion. The mention grammar
 * (`MENTION_TOKEN_PATTERN`, `splitCodeSpans`) is the server's single definition in
 * `@lrm/coforge-sdk/internal/mentions`, so highlight and wake rules can never disagree about what
 * counts as a mention; the message renderer consumes it through `message-markdown.ts`.
 * Rendering is token-only by design (no legacy plain-`@handle` compatibility).
 */
import { replaceMentionTokens } from "@lrm/coforge-sdk/internal";

/** One resolved mention row as the browser message view carries it. `handle` is stable identity;
 * `label` is the current profile display name (falling back to that handle). */
export type MentionRef = {
  kind: "user" | "agent";
  actorId: string;
  handle: string;
  label: string;
};

/**
 * A function that rewrites a stored body's mention tokens (`<@agent:uuid>` / `<@human:uuid>`) to
 * their `@handle`, using the given mentionables, or `undefined` when there is nothing to resolve.
 * Used by list/summary views (e.g. the own-messages jump index) that show the stored body as
 * plain text and would otherwise leak the raw token. An unknown token is left byte-for-byte
 * intact (see `replaceMentionTokens`), so the caller degrades to the raw token rather than
 * dropping it. This is only display formatting — the stored body and wake rules are unchanged.
 */
export function makeMentionBodyFormatter(
  mentionables: readonly {
    kind: "user" | "agent";
    id: string;
    handle: string;
    label: string;
  }[],
): ((body: string) => string) | undefined {
  const labelById = new Map(
    mentionables.map((mention) => [`${mention.kind}:${mention.id.toLowerCase()}`, mention.label]),
  );
  if (labelById.size === 0) return undefined;
  return (body: string) =>
    replaceMentionTokens(body, (type, id) => {
      const label = labelById.get(`${type}:${id.toLowerCase()}`);
      return label ? `@${label}` : undefined;
    });
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
 * The @-completion query at the caret: the in-progress token starts at `@` and runs to the caret
 * using handle characters only. Returns the token's start offset (the `@` itself) and the typed
 * query without it. `undefined` when the caret is not inside such a token — inside an email
 * address, inside a handle-shaped word, or past a completed mention followed by more handle
 * characters.
 *
 * A mention may start at the beginning of the text, after whitespace, or after any character that
 * cannot itself be part of a handle. That last case is what makes "写点东西@alice" work: typing `@`
 * directly against Chinese text (or after punctuation, or an emoji) is how a mention is normally
 * written there, and requiring a space before it silently produced no popup at all. `foo@bar` and
 * a second `@` inside a mention stay plain text, because a handle character is not a boundary.
 */
export function activeMentionQuery(
  value: string,
  caret: number,
): { start: number; query: string } | undefined {
  const beforeCaret = value.slice(0, caret);
  const match = /(?:^|[^a-z0-9_-])@([a-z0-9_-]*)$/.exec(beforeCaret);
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
