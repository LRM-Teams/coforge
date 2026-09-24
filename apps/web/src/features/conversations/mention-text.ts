/**
 * Pure mention text logic for the conversation UI, free of React and DOM types: the composer's
 * @-completion ranking (query detection and insertion are shared with the `#` channel list in
 * `reference-completion.ts`). The mention grammar
 * (`MENTION_TOKEN_PATTERN`, `splitCodeSpans`) is the server's single definition in
 * `@lrm/coforge-sdk/internal/mentions`, so highlight and wake rules can never disagree about what
 * counts as a mention; the message renderer consumes it through `message-markdown.ts`.
 * Rendering is token-only by design (no legacy plain-`@handle` compatibility).
 */
import { readableBody } from "@lrm/coforge-sdk/internal";
import { nameMatchTier } from "#src/lib/name-match";

/** One resolved mention row as the browser message view carries it. `handle` is stable identity;
 * `label` is the current profile display name (falling back to that handle). */
export type MentionRef = {
  kind: "user" | "agent";
  actorId: string;
  handle: string;
  label: string;
};

/**
 * A function that rewrites a stored body's tokens for list/summary views (e.g. the own-messages
 * jump index, the thread previews) that show the stored body as plain text and would otherwise
 * leak the raw token: a mention token (`<@agent:uuid>` / `<@human:uuid>`) to its `@label` from the
 * given mentionables, a task token to `task #N`, and a channel token to `#name` — the current name
 * from `channelNames` (channel id → name) when listed, the stored one otherwise. An unknown mention
 * token is left byte-for-byte intact (see `readableBody`), so the caller degrades to the
 * raw token rather than dropping it. This is only display formatting — the stored body and wake
 * rules are unchanged.
 */
export function makeReferenceBodyFormatter(
  mentionables: readonly {
    kind: "user" | "agent";
    id: string;
    handle: string;
    label: string;
  }[],
  channelNames?: ReadonlyMap<string, string>,
): (body: string) => string {
  const labelById = new Map(
    mentionables.map((mention) => [`${mention.kind}:${mention.id.toLowerCase()}`, mention.label]),
  );
  return (body: string) =>
    readableBody(body, {
      mention: (type, id) => labelById.get(`${type}:${id.toLowerCase()}`),
      channelName: (id) => channelNames?.get(id),
    });
}

export type Mentionable = {
  kind: "user" | "agent";
  id: string;
  /** The handle inserted into the text and matched by `MENTION_PATTERN`. */
  handle: string;
  /** Human-facing label shown next to the handle in the completion list. */
  label: string;
  /** A short profile description shown after the name on the completion row, trimmed. Empty
   * when the profile has none; the row then shows no description. */
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
 * Completion candidates for a query, ranked the way a fast channel-mention popup should read:
 * closer text matches first (see `nameMatchTier`), then within a tier whoever the viewer has
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
      const tier = nameMatchTier(item.label, [item.handle], lowerQuery);
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
