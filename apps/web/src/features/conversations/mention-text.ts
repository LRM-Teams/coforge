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
  /** What the server resolves the mention by (matched by `MENTION_PATTERN`): sending writes it into
   * the text, and an Agent's row shows it. A person's is not shown or searched. */
  handle: string;
  /** The name the completion list shows, the composer writes after the `@`, and the list is
   * searched by. */
  label: string;
  /** A person's full name, when it is not already their label (they have a nickname): the list
   * finds them by it too, as a directory search finds anyone by either name. */
  fullName?: string;
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
  /** Not a member of the channel: offered in its own group, and a mention of them notifies no one
   * until the sender acts on it. */
  outsider?: true;
};

/** One candidate's identity across the person and Agent lists: ids are unique per table, not across
 * people and Agents, so the kind is part of the key. */
export function mentionKey(mention: Pick<Mentionable, "kind" | "id">): string {
  return `${mention.kind}:${mention.id}`;
}

/**
 * Which rows of the `@` list show their `@handle`. An Agent's handle is its public name, so its
 * row always does. A person's handle stays hidden (the list shows who they are, not an identifier)
 * except where the list holds two people whose label and description are both identical: nothing
 * else on their rows tells them apart, so their handles do. Only people are compared with people.
 */
export function mentionKeysShowingHandle(items: readonly Mentionable[]): Set<string> {
  const shown = new Set<string>();
  const firstOfLook = new Map<string, Mentionable>();
  for (const item of items) {
    if (item.kind === "agent") {
      shown.add(mentionKey(item));
      continue;
    }
    const look = `${item.label}\u0000${item.description}`;
    const first = firstOfLook.get(look);
    if (!first) firstOfLook.set(look, item);
    else {
      shown.add(mentionKey(first));
      shown.add(mentionKey(item));
    }
  }
  return shown;
}

/**
 * The names the `@` list finds a candidate by besides its label. A person's handle is not shown, so
 * a match on it would be a hit the reader cannot explain; their full name is who they are, so it
 * matches under a nickname. An Agent's handle is its public name, so it matches.
 */
function mentionSearchNames(mention: Pick<Mentionable, "kind" | "handle" | "fullName">): string[] {
  if (mention.kind === "agent") return [mention.handle];
  return mention.fullName ? [mention.fullName] : [];
}

/**
 * Completion candidates for a query, ranked the way a fast channel-mention popup should read:
 * closer text matches first (see `nameMatchTier`, on the label and `mentionSearchNames`), then
 * within a tier whoever the viewer has mentioned most (`item.mentionScore`, higher first), then
 * whoever spoke most recently in this conversation (`recentHandles`, most-recent first, by handle:
 * an internal key, never shown), then alphabetically by label and by handle. The empty query
 * matches everyone at the same tier, so score, recency, and alphabetical order alone decide the
 * list. Capped by `limit`.
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
      const tier = nameMatchTier(item.label, mentionSearchNames(item), lowerQuery);
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
