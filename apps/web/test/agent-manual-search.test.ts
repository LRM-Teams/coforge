import { expect, test } from "bun:test";
import {
  manualFirstScreen,
  searchManualTopics,
  tokenizeManualQuery,
} from "@/server/agents/manual/manual-search.server";
import type { AgentManualTopic } from "@/server/agents/manual/manual-registry.server";
import {
  buildManualIndexContent,
  findManualTopic,
  manualDocVersion,
  MANUAL_TOPICS,
} from "@/server/agents/manual/manual-registry.server";
import {
  isValidManualTopicSlug,
  validateManualQuery,
} from "@/server/agents/manual/manual-validation.server";

const FIXTURE_TOPICS: AgentManualTopic[] = [
  {
    slug: "github",
    title: "Working with GitHub",
    summary: "Clone a repository and open a pull request.",
    body: "# Working with GitHub\n\nClone with git clone.\nOpen a pull request with gh pr create.\n",
  },
  {
    slug: "manual",
    title: "Using the Manual",
    summary: "How to read topics and search by keyword.",
    body: "# Using the Manual\n\nRun coforge manual get to read a topic.\n",
  },
  {
    slug: "channels-zh",
    title: "頻道使用說明",
    summary: "如何加入頻道並發送訊息。",
    body: "# 頻道使用說明\n\n使用 coforge channel join 加入頻道。\n之後即可發送訊息。\n",
  },
];

test("tokenizeManualQuery drops short latin tokens but keeps any-length CJK runs", () => {
  expect(tokenizeManualQuery("a to GitHub!")).toEqual(["to", "github"]);
  expect(tokenizeManualQuery("频道")).toEqual(["频道"]);
  expect(tokenizeManualQuery("")).toEqual([]);
});

test("searchManualTopics scores title/slug over summary over body and requires a hit", () => {
  const results = searchManualTopics("GitHub", FIXTURE_TOPICS);
  expect(results).toHaveLength(1);
  expect(results[0]!.slug).toBe("github");

  // "pull request" only appears in the github topic's body.
  const bodyOnly = searchManualTopics("pull request", FIXTURE_TOPICS);
  expect(bodyOnly.map((r) => r.slug)).toEqual(["github"]);

  expect(searchManualTopics("nonexistentterm", FIXTURE_TOPICS)).toEqual([]);
});

test("searchManualTopics sorts by score desc then slug asc and caps at 5 results", () => {
  const manyTopics: AgentManualTopic[] = Array.from({ length: 7 }, (_, i) => ({
    slug: `topic-${i}`,
    title: "widget",
    summary: "widget",
    body: "widget",
  }));
  const results = searchManualTopics("widget", manyTopics);
  expect(results).toHaveLength(5);
  expect(results.map((r) => r.slug)).toEqual([
    "topic-0",
    "topic-1",
    "topic-2",
    "topic-3",
    "topic-4",
  ]);
});

test("searchManualTopics matches a CJK query by substring, not word boundary", () => {
  const results = searchManualTopics("頻道", FIXTURE_TOPICS);
  expect(results.map((r) => r.slug)).toEqual(["channels-zh"]);
});

test("searchManualTopics never matches a latin token as a substring of an unrelated word", () => {
  // "cat" must not match inside "location" if such a word existed; use a concrete near-miss here.
  const topics: AgentManualTopic[] = [
    { slug: "a", title: "location tools", summary: "s", body: "b" },
  ];
  expect(searchManualTopics("cat", topics)).toEqual([]);
});

test("searchManualTopics matches a latin token from a word start", () => {
  const topics: AgentManualTopic[] = [
    { slug: "a", title: "Working with a repository", summary: "s", body: "cloning" },
  ];
  expect(searchManualTopics("repo", topics).map((r) => r.slug)).toEqual(["a"]);
  expect(searchManualTopics("clon", topics).map((r) => r.slug)).toEqual(["a"]);
});

test("manualFirstScreen combines the summary with body lines after the H1, capped in length", () => {
  const firstScreen = manualFirstScreen(FIXTURE_TOPICS[0]!);
  expect(firstScreen.startsWith(FIXTURE_TOPICS[0]!.summary)).toBe(true);
  expect(firstScreen).toContain("Clone with git clone.");
  expect(firstScreen).not.toContain("# Working with GitHub");
  expect(firstScreen.length).toBeLessThanOrEqual(600);
});

test("isValidManualTopicSlug enforces the lowercase/hyphen/slash grammar and length cap", () => {
  expect(isValidManualTopicSlug("github")).toBe(true);
  expect(isValidManualTopicSlug("github-repo")).toBe(true);
  expect(isValidManualTopicSlug("project/github")).toBe(true);
  expect(isValidManualTopicSlug("")).toBe(false);
  expect(isValidManualTopicSlug("GitHub")).toBe(false);
  expect(isValidManualTopicSlug("-github")).toBe(false);
  expect(isValidManualTopicSlug("a".repeat(121))).toBe(false);
});

test("validateManualQuery rejects an empty or overlong query", () => {
  expect(validateManualQuery("github")).toBeUndefined();
  expect(validateManualQuery("")?.errorCode).toBe("knowledge_query_invalid");
  expect(validateManualQuery("x".repeat(201))?.errorCode).toBe("knowledge_query_invalid");
  expect(validateManualQuery(undefined)?.errorCode).toBe("knowledge_query_invalid");
  // Punctuation or a single latin letter yields no keyword at all.
  expect(validateManualQuery("?! a")?.errorCode).toBe("knowledge_query_invalid");
  expect(validateManualQuery("拉")).toBeUndefined();
});

test("the generated index lists every registered topic with its slug and title", () => {
  const content = buildManualIndexContent();
  for (const topic of MANUAL_TOPICS) expect(content).toContain(`${topic.slug} — ${topic.title}`);
  expect(content).toContain("coforge manual get");
  expect(content).toContain("coforge manual search");
});

test("findManualTopic and manualDocVersion are stable and content-derived", () => {
  const github = findManualTopic("github");
  expect(github?.slug).toBe("github");
  expect(findManualTopic("does-not-exist")).toBeUndefined();
  expect(manualDocVersion("a")).toBe(manualDocVersion("a"));
  expect(manualDocVersion("a")).not.toBe(manualDocVersion("b"));
});

test("the tasks topic carries the full task reference removed from the standing prompt", () => {
  const body = findManualTopic("tasks")?.body ?? "";
  expect(body).toContain("**Decision rule:**");
  expect(body).toContain("**Claim** is rejected on both terminal statuses");
  expect(body).toContain("**Amendments are auditable:**");
  expect(body).toContain("If the claim fails, do not start conflicting execution");
  expect(body).toContain("**What `coforge task create` really means:**");
  expect(body).toContain("Before calling `coforge task create`");
  expect(searchManualTopics("task claim status").map((r) => r.slug)[0]).toBe("tasks");
  expect(body).toContain("**Splitting tasks for parallel execution:**");
});

test("P3 topics hold the how-to moved out of the standing prompt", () => {
  expect(findManualTopic("channels")?.body).toContain("coforge channel mute --target '#general'");
  expect(findManualTopic("reminders")?.body).toContain(
    "A reminder wakes only the Agent that scheduled it.",
  );
  expect(findManualTopic("action-cards")?.body).toContain("coforge action prepare");
  expect(findManualTopic("attachments")?.body).toContain("--attachment-id");
  expect(findManualTopic("etiquette")?.body).toContain("## Live constraints");
  expect(findManualTopic("memory")?.body).toContain("# <Your Name>");
  expect(MANUAL_TOPICS.map((topic) => topic.slug)).toEqual([
    "action-cards",
    "attachments",
    "channels",
    "etiquette",
    "github",
    "manual",
    "memory",
    "profile",
    "reminders",
    "tasks",
  ]);
});
