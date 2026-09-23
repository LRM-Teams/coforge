import type { AgentManualSearchResult } from "@lrm/coforge-sdk/agent";
import { MANUAL_TOPICS, type AgentManualTopic } from "./manual-registry.server";

const MAX_RESULTS = 5;
const FIRST_SCREEN_MAX_LENGTH = 600;
const FIRST_SCREEN_BODY_LINES = 6;

// CJK scripts (Han, Hiragana/Katakana, Hangul) do not word-break on whitespace the way Latin
// text does, so a token containing one of these is matched by substring rather than a word
// boundary (see `topicMatchesToken` below).
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u;
const TOKEN_SPLIT_PATTERN = /[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]+/u;

/** Lowercases the query, splits on whitespace/punctuation, and drops short non-CJK tokens (a CJK
 * run of any length is kept: a single Han/Hangul/Kana character already carries meaning). */
export function tokenizeManualQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(TOKEN_SPLIT_PATTERN)
    .filter((token) => token.length > 0)
    .filter((token) => CJK_PATTERN.test(token) || token.length >= 2);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A CJK token matches by plain substring (no word boundary concept applies); any other token
 * matches from a word start, so `"repo"` hits `"repository"` and `"clon"` hits `"cloning"`, but
 * `"cat"` does not spuriously hit `"location"`. */
function textContainsToken(haystackLower: string, token: string): boolean {
  if (CJK_PATTERN.test(token)) return haystackLower.includes(token);
  return new RegExp(`\\b${escapeRegExp(token)}`, "u").test(haystackLower);
}

/** Title/slug matches weigh more than summary, summary more than body; a topic with zero token
 * hits anywhere never enters the results. */
function scoreTopic(topic: AgentManualTopic, tokens: readonly string[]): number {
  const titleAndSlug = `${topic.slug} ${topic.title}`.toLowerCase();
  const summary = topic.summary.toLowerCase();
  const body = topic.body.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (textContainsToken(titleAndSlug, token)) score += 5;
    else if (textContainsToken(summary, token)) score += 3;
    else if (textContainsToken(body, token)) score += 1;
  }
  return score;
}

/** Summary plus the first ~6 non-empty body lines after the leading `# Title` heading, capped to
 * ~600 characters. */
export function manualFirstScreen(topic: AgentManualTopic): string {
  const lines = topic.body.split("\n");
  const startIndex = lines[0]?.startsWith("# ") ? 1 : 0;
  const bodyLines = lines
    .slice(startIndex)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, FIRST_SCREEN_BODY_LINES);
  const combined = [topic.summary, ...bodyLines].join("\n");
  return combined.length > FIRST_SCREEN_MAX_LENGTH
    ? combined.slice(0, FIRST_SCREEN_MAX_LENGTH)
    : combined;
}

/** Plain keyword scoring over the topic registry (v1: no embeddings, no typo/concept expansion).
 * Sorted by score descending, then slug ascending; at most 5 results. Assumes the caller has
 * already validated the raw query string (see `manual-validation.ts`). `topics` defaults to the
 * real registry; tests inject a small fixture list instead of editing real topic content. */
export function searchManualTopics(
  query: string,
  topics: readonly AgentManualTopic[] = MANUAL_TOPICS,
): AgentManualSearchResult[] {
  const tokens = tokenizeManualQuery(query);
  if (tokens.length === 0) return [];
  return topics
    .map((topic) => ({ topic, score: scoreTopic(topic, tokens) }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score || a.topic.slug.localeCompare(b.topic.slug))
    .slice(0, MAX_RESULTS)
    .map(({ topic }) => ({
      slug: topic.slug,
      title: topic.title,
      firstScreen: manualFirstScreen(topic),
    }));
}
