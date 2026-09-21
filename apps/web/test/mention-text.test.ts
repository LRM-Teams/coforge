import { expect, test } from "bun:test";

import {
  activeMentionQuery,
  filterMentionables,
  makeMentionBodyFormatter,
  type Mentionable,
} from "../src/features/conversations/mention-text";

function person(handle: string, label: string, description = "", mentionScore = 0): Mentionable {
  return {
    kind: "user",
    id: `user-${handle}`,
    handle,
    label,
    description,
    avatarUrl: null,
    mentionScore,
  };
}

function agent(handle: string, label: string, description = "", mentionScore = 0): Mentionable {
  return { kind: "agent", id: `agent-${handle}`, handle, label, description, mentionScore };
}

test("an exact handle match outranks a prefix-only match", () => {
  const exact = person("ada", "Ada Lovelace");
  const prefixOnly = person("adalene", "Adalene Smith");
  const ranked = filterMentionables([prefixOnly, exact], "ada");
  expect(ranked.map((item) => item.handle)).toEqual(["ada", "adalene"]);
});

test("tier order: exact, then prefix, then a later label word, then any other substring", () => {
  const exact = person("grace", "grace");
  const prefix = person("gracehopper", "Grace Hopper");
  const laterWord = person("admiral", "Admiral Grace");
  const substringOnly = person("navigator", "Navigator (Grace's team)");
  const noMatch = person("outsider", "Not Related");

  const ranked = filterMentionables([substringOnly, laterWord, noMatch, prefix, exact], "grace");

  expect(ranked.map((item) => item.handle)).toEqual([
    "grace",
    "gracehopper",
    "admiral",
    "navigator",
  ]);
});

test("a query matching only a later label word (e.g. a surname) ranks above a plain substring hit", () => {
  const surname = person("gracehopper", "Grace Hopper");
  const substring = person("shopper", "Shopping Bot");

  const ranked = filterMentionables([substring, surname], "hop");

  expect(ranked.map((item) => item.handle)).toEqual(["gracehopper", "shopper"]);
});

test("matching is case-insensitive against the handle, the label, and label words", () => {
  const ranked = filterMentionables([person("Ada", "Ada Lovelace")], "LOVE");
  expect(ranked.map((item) => item.handle)).toEqual(["Ada"]);
});

test("a query with no matching handle, label, or label word is excluded", () => {
  const ranked = filterMentionables([person("ada", "Ada Lovelace")], "zzz");
  expect(ranked).toEqual([]);
});

test("within a tier, whoever spoke most recently in the conversation sorts first", () => {
  const ada = person("ada", "Ada");
  const bea = person("bea", "Bea");
  const cid = person("cid", "Cid");

  const ranked = filterMentionables([ada, bea, cid], "", {
    recentHandles: ["cid", "ada"],
  });

  // cid and ada spoke recently (cid most recently); bea never spoke, so it sorts last.
  expect(ranked.map((item) => item.handle)).toEqual(["cid", "ada", "bea"]);
});

test("within a tier, a higher mention score outranks whoever merely spoke most recently", () => {
  const oftenMentioned = person("ada", "Ada", "", 40);
  const recentSpeaker = person("bea", "Bea", "", 0);

  const ranked = filterMentionables([recentSpeaker, oftenMentioned], "", {
    recentHandles: ["bea"],
  });

  expect(ranked.map((item) => item.handle)).toEqual(["ada", "bea"]);
});

test("a match tier still dominates mention score: a better text match wins even with a lower score", () => {
  const exactMatchLowScore = person("ada", "Ada", "", 0);
  const substringMatchHighScore = person("canada", "Canada Bot", "", 90);

  const ranked = filterMentionables([substringMatchHighScore, exactMatchLowScore], "ada");

  expect(ranked.map((item) => item.handle)).toEqual(["ada", "canada"]);
});

test("recentHandles entries are matched without a leading @ and case-insensitively", () => {
  const ada = person("Ada", "Ada");
  const bea = person("Bea", "Bea");

  const ranked = filterMentionables([bea, ada], "", { recentHandles: ["@ada"] });

  expect(ranked.map((item) => item.handle)).toEqual(["Ada", "Bea"]);
});

test("candidates with no recency fall back to locale-aware alphabetical order by label", () => {
  const ranked = filterMentionables(
    [person("z", "Zoe"), person("a", "Amir"), person("m", "Mina")],
    "",
  );
  expect(ranked.map((item) => item.label)).toEqual(["Amir", "Mina", "Zoe"]);
});

test("equal labels fall back to alphabetical order by handle", () => {
  const ranked = filterMentionables([person("zed", "Assistant"), person("abe", "Assistant")], "");
  expect(ranked.map((item) => item.handle)).toEqual(["abe", "zed"]);
});

test("the empty query matches everyone at the same tier, so limit and ordering alone decide the list", () => {
  const many = Array.from({ length: 10 }, (_, index) =>
    person(`user${index}`, `User ${String(index).padStart(2, "0")}`),
  );
  const ranked = filterMentionables(many, "");
  expect(ranked).toHaveLength(8);
  expect(ranked.map((item) => item.label)).toEqual([
    "User 00",
    "User 01",
    "User 02",
    "User 03",
    "User 04",
    "User 05",
    "User 06",
    "User 07",
  ]);
});

test("limit caps the result while keeping the best-ranked candidates", () => {
  const ranked = filterMentionables(
    [person("a", "Alice"), person("ab", "Abby"), person("abc", "Abraham")],
    "a",
    { limit: 2 },
  );
  expect(ranked).toHaveLength(2);
});

test("an Agent candidate ranks and sorts the same way as a person candidate", () => {
  const ranked = filterMentionables([agent("scout", "Scout"), person("ada", "Ada")], "");
  expect(ranked.map((item) => item.handle)).toEqual(["ada", "scout"]);
});

const AGENT_UUID = "bf69603b-642b-40d7-b877-0080e29f4306";
const USER_UUID = "11111111-2222-4333-8444-555555555555";

test("makeMentionBodyFormatter rewrites an Agent token to its display label", () => {
  const format = makeMentionBodyFormatter([
    { kind: "agent", id: AGENT_UUID, handle: "kiro", label: "Kiro Reviewer" },
  ]);
  expect(format?.(`hi <@agent:${AGENT_UUID}> there`)).toBe("hi @Kiro Reviewer there");
});

test("makeMentionBodyFormatter resolves a human label and is case-insensitive on the uuid", () => {
  const format = makeMentionBodyFormatter([
    { kind: "user", id: USER_UUID, handle: "ada", label: "Ada Lovelace" },
  ]);
  expect(format?.(`<@human:${USER_UUID.toUpperCase()}>`)).toBe("@Ada Lovelace");
});

test("makeMentionBodyFormatter leaves an unknown token intact rather than dropping it", () => {
  const format = makeMentionBodyFormatter([
    { kind: "agent", id: AGENT_UUID, handle: "kiro", label: "Kiro Reviewer" },
  ]);
  const other = "e14e9498-e145-4686-9999-000000000000";
  expect(format?.(`<@agent:${other}>`)).toBe(`<@agent:${other}>`);
});

test("makeMentionBodyFormatter returns undefined when there is nothing to resolve", () => {
  expect(makeMentionBodyFormatter([])).toBeUndefined();
});

test("an @query is found at the start of the text and after a space", () => {
  expect(activeMentionQuery("@al", 3)).toEqual({ start: 0, query: "al" });
  expect(activeMentionQuery("hi @al", 6)).toEqual({ start: 3, query: "al" });
  expect(activeMentionQuery("hi @", 4)).toEqual({ start: 3, query: "" });
});

test("a mention starts only at the start of the text or after whitespace (the strict convention)", () => {
  // Task #64: typing the message first and then @-mentioning without a space does NOT open the
  // popup, because that is Slack's and Discord's boundary. The looser rule (fire after any
  // non-handle character, which would also cover CJK text) was tried and rejected in favour of
  // aligning with the convention.
  expect(activeMentionQuery("写点东西@alice", "写点东西@alice".length)).toBeUndefined();
  expect(activeMentionQuery("写点东西 @alice", "写点东西 @alice".length)).toEqual({
    start: 5,
    query: "alice",
  });
  expect(activeMentionQuery("done!@al", 7)).toBeUndefined();
  expect(activeMentionQuery("done! @al", "done! @al".length)).toEqual({ start: 6, query: "al" });
});

test("a handle-shaped character is not a boundary, so an email or a second @ stays plain text", () => {
  expect(activeMentionQuery("foo@bar", 7)).toBeUndefined();
  expect(activeMentionQuery("@ada@b", 6)).toBeUndefined();
  expect(activeMentionQuery("no at sign here", 15)).toBeUndefined();
});

test("the query ends at the caret, not at the end of the text", () => {
  expect(activeMentionQuery("@alice wrote", 3)).toEqual({ start: 0, query: "al" });
  expect(activeMentionQuery("hi @alice more", 6)).toEqual({ start: 3, query: "al" });
  expect(activeMentionQuery("hi @alice more", 5)).toEqual({ start: 3, query: "a" });
});

test("a caret before any @ finds nothing", () => {
  expect(activeMentionQuery("@alice", 0)).toBeUndefined();
});
