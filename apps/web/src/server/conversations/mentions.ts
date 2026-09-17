import { MENTION_PATTERN, replaceMentionTokens } from "@lrm/coforge-sdk/internal";

export function mentionedNames(body: string) {
  return [...body.matchAll(MENTION_PATTERN)].map((match) => match[1]!);
}

/** The mention-row projection every body reader needs to resolve embedded tokens. */
export type MessageMentionRef = { kind: string; actorId: string; handle: string };

/**
 * The Agent-facing body: embedded mention tokens (`<@human:uuid>`/`<@agent:uuid>`) read back as
 * plain `@handle` text. The token form is a storage/browser-render concern and never crosses
 * onto the Agent channel; an unresolved token (no matching mention row) stays as written.
 */
export function agentReadableBody(body: string, mentions: readonly MessageMentionRef[]): string {
  return replaceMentionTokens(body, (type, id) => {
    const mention = mentions.find((row) => row.kind === type && row.actorId.toLowerCase() === id);
    return mention ? `@${mention.handle}` : undefined;
  });
}

/** One of the viewer's own past @-mentions, as read back for affinity scoring. */
export type RecentMentionRow = { kind: string; actorId: string; createdAt: Date };

/** The age buckets `mentionAffinityScores` scores a single mention timestamp by, ordered
 * newest-first; a timestamp older than every bucket's `maxAgeMs` scores 0. */
const MENTION_AGE_POINTS: readonly { maxAgeMs: number; points: number }[] = [
  { maxAgeMs: 4 * 60 * 60 * 1000, points: 100 },
  { maxAgeMs: 24 * 60 * 60 * 1000, points: 80 },
  { maxAgeMs: 3 * 24 * 60 * 60 * 1000, points: 60 },
  { maxAgeMs: 7 * 24 * 60 * 60 * 1000, points: 40 },
  { maxAgeMs: 30 * 24 * 60 * 60 * 1000, points: 20 },
  { maxAgeMs: 90 * 24 * 60 * 60 * 1000, points: 10 },
];

function mentionAgePoints(ageMs: number): number {
  return MENTION_AGE_POINTS.find((bucket) => ageMs <= bucket.maxAgeMs)?.points ?? 0;
}

/**
 * How strongly the viewer has recently and repeatedly @-mentioned each actor in one channel,
 * from a bounded window of the viewer's own sent mentions there (the caller fetches at most the
 * 50 newest). Keyed by `${kind}:${actorId}`, the same pair the @-completion list's candidates
 * carry. For each actor, only their newest 10 mention timestamps (within the fetched window)
 * are aged into points — a mention in the last 4 hours scores highest, one older than 90 days
 * scores nothing — and the average of those points is then scaled by how many times the viewer
 * mentioned that actor in total within the window, so a person mentioned ten times recently
 * outranks one mentioned only once, even if that single mention is the more recent of the two.
 * `now` is injectable so age scoring is deterministic under test.
 */
export function mentionAffinityScores(
  mentions: readonly RecentMentionRow[],
  now: Date = new Date(),
): Map<string, number> {
  const rowsByActor = new Map<string, RecentMentionRow[]>();
  for (const mention of mentions) {
    const key = `${mention.kind}:${mention.actorId}`;
    const rows = rowsByActor.get(key);
    if (rows) rows.push(mention);
    else rowsByActor.set(key, [mention]);
  }

  const scores = new Map<string, number>();
  const nowMs = now.getTime();
  for (const [key, rows] of rowsByActor) {
    const newest = [...rows]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, 10);
    const pointsSum = newest.reduce(
      (sum, row) => sum + mentionAgePoints(nowMs - row.createdAt.getTime()),
      0,
    );
    scores.set(key, Math.round((rows.length * pointsSum) / newest.length));
  }
  return scores;
}
