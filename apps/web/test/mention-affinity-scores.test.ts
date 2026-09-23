import { expect, test } from "bun:test";

import {
  mentionAffinityScores,
  type RecentMentionRow,
} from "#src/server/conversations/mentions.server";

const NOW = new Date("2026-09-17T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function mentionAgo(kind: string, actorId: string, ageMs: number): RecentMentionRow {
  return { kind, actorId, createdAt: new Date(NOW.getTime() - ageMs) };
}

test("a single mention within the last 4 hours scores 100", () => {
  const scores = mentionAffinityScores([mentionAgo("user", "ada", HOUR)], NOW);
  expect(scores.get("user:ada")).toBe(100);
});

test("a single mention ages down through the score buckets", () => {
  expect(mentionAffinityScores([mentionAgo("user", "ada", 2 * DAY)], NOW).get("user:ada")).toBe(60);
  expect(mentionAffinityScores([mentionAgo("user", "ada", 6 * DAY)], NOW).get("user:ada")).toBe(40);
  expect(mentionAffinityScores([mentionAgo("user", "ada", 20 * DAY)], NOW).get("user:ada")).toBe(
    20,
  );
  expect(mentionAffinityScores([mentionAgo("user", "ada", 60 * DAY)], NOW).get("user:ada")).toBe(
    10,
  );
});

test("a mention older than 90 days scores 0", () => {
  const scores = mentionAffinityScores([mentionAgo("user", "ada", 200 * DAY)], NOW);
  expect(scores.get("user:ada")).toBe(0);
});

test("a bucket boundary is inclusive of the newer bucket", () => {
  const scores = mentionAffinityScores([mentionAgo("user", "ada", 4 * HOUR)], NOW);
  expect(scores.get("user:ada")).toBe(100);
});

test("mentioning the same actor more than once scales the score by how many times, not just how recently", () => {
  const oneRecentMention = mentionAffinityScores([mentionAgo("user", "ada", HOUR)], NOW).get(
    "user:ada",
  );
  const threeRecentMentions = mentionAffinityScores(
    [
      mentionAgo("user", "ada", HOUR),
      mentionAgo("user", "ada", HOUR),
      mentionAgo("user", "ada", HOUR),
    ],
    NOW,
  ).get("user:ada");
  expect(oneRecentMention).toBe(100);
  expect(threeRecentMentions).toBe(300);
});

test("only the newest 10 timestamps age into the score, but every mention still counts toward the total", () => {
  const rows: RecentMentionRow[] = Array.from({ length: 15 }, () =>
    mentionAgo("user", "ada", HOUR),
  );
  // 15 total mentions, all in the highest bucket: average of the newest 10 (100 each) times the
  // full count of 15, not diluted by the 5 mentions outside the averaging window.
  expect(mentionAffinityScores(rows, NOW).get("user:ada")).toBe(1500);
});

test("scores are grouped independently per actor, keyed by kind and id", () => {
  const scores = mentionAffinityScores(
    [mentionAgo("user", "ada", HOUR), mentionAgo("agent", "ada", 60 * DAY)],
    NOW,
  );
  expect(scores.get("user:ada")).toBe(100);
  expect(scores.get("agent:ada")).toBe(10);
});

test("an actor never mentioned has no entry, so callers default to 0", () => {
  const scores = mentionAffinityScores([mentionAgo("user", "ada", HOUR)], NOW);
  expect(scores.has("user:bea")).toBe(false);
});

test("no mentions produces an empty score map", () => {
  expect(mentionAffinityScores([], NOW).size).toBe(0);
});
