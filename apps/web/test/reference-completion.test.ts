import { expect, test } from "bun:test";

import {
  activeReferenceQuery,
  filterChannelSuggestions,
  insertReference,
  type ChannelSuggestion,
} from "#src/features/conversations/reference-completion";

function channel(name: string, description = "", archived = false): ChannelSuggestion {
  return { id: `channel-${name}`, name, description, archived };
}

const end = (text: string) => text.length;

test("an @query is found at the start of the text and after a space", () => {
  expect(activeReferenceQuery("@al", 3)).toEqual({ trigger: "@", start: 0, query: "al" });
  expect(activeReferenceQuery("hi @al", 6)).toEqual({ trigger: "@", start: 3, query: "al" });
  expect(activeReferenceQuery("hi @", 4)).toEqual({ trigger: "@", start: 3, query: "" });
});

test("a mention starts only at the start of the text or after whitespace (the strict convention)", () => {
  // Task #64: typing the message first and then @-mentioning without a space does NOT open the
  // popup, because that is Slack's and Discord's boundary. The looser rule (fire after any
  // non-handle character, which would also cover CJK text) was tried and rejected in favour of
  // aligning with the convention.
  expect(activeReferenceQuery("写点东西@alice", end("写点东西@alice"))).toBeUndefined();
  expect(activeReferenceQuery("写点东西 @alice", end("写点东西 @alice"))).toEqual({
    trigger: "@",
    start: 5,
    query: "alice",
  });
  expect(activeReferenceQuery("done!@al", 7)).toBeUndefined();
  expect(activeReferenceQuery("done! @al", end("done! @al"))).toEqual({
    trigger: "@",
    start: 6,
    query: "al",
  });
});

test("a handle-shaped character is not a boundary, so an email or a second @ stays plain text", () => {
  expect(activeReferenceQuery("foo@bar", 7)).toBeUndefined();
  expect(activeReferenceQuery("@ada@b", 6)).toBeUndefined();
  expect(activeReferenceQuery("no at sign here", 15)).toBeUndefined();
});

test("the query ends at the caret, not at the end of the text", () => {
  expect(activeReferenceQuery("@alice wrote", 3)).toEqual({ trigger: "@", start: 0, query: "al" });
  expect(activeReferenceQuery("hi @alice more", 6)).toEqual({
    trigger: "@",
    start: 3,
    query: "al",
  });
  expect(activeReferenceQuery("hi @alice more", 5)).toEqual({ trigger: "@", start: 3, query: "a" });
});

test("a caret before any @ finds nothing", () => {
  expect(activeReferenceQuery("@alice", 0)).toBeUndefined();
});

test("a #query opens at the start of the text and after whitespace, like an @query", () => {
  expect(activeReferenceQuery("#", 1)).toEqual({ trigger: "#", start: 0, query: "" });
  expect(activeReferenceQuery("see #r", 6)).toEqual({ trigger: "#", start: 4, query: "r" });
  expect(activeReferenceQuery("line\n#prod", end("line\n#prod"))).toEqual({
    trigger: "#",
    start: 5,
    query: "prod",
  });
  expect(activeReferenceQuery("写点东西 #random", end("写点东西 #random"))).toEqual({
    trigger: "#",
    start: 5,
    query: "random",
  });
});

test("a # straight after a word, or a second #, opens nothing", () => {
  expect(activeReferenceQuery("abc#", 4)).toBeUndefined();
  expect(activeReferenceQuery("写点东西#random", end("写点东西#random"))).toBeUndefined();
  expect(activeReferenceQuery("##", 2)).toBeUndefined();
  expect(activeReferenceQuery("@ada#r", 6)).toBeUndefined();
});

test("a character outside the channel-name grammar ends the #query", () => {
  // A space (a Markdown heading) or the `:` of a thread reference closes the list.
  expect(activeReferenceQuery("# heading", 2)).toBeUndefined();
  expect(activeReferenceQuery("#product:abc123", end("#product:abc123"))).toBeUndefined();
  expect(activeReferenceQuery("#Product", 8)).toBeUndefined();
});

test("inline code keeps both triggers closed, and a closed code span no longer does", () => {
  expect(activeReferenceQuery("run `#", end("run `#"))).toBeUndefined();
  expect(activeReferenceQuery("run `x @al", end("run `x @al"))).toBeUndefined();
  // The caret inside a finished span on the same line is still in code.
  expect(activeReferenceQuery("`a #r b`", 5)).toBeUndefined();
  expect(activeReferenceQuery("`code` #r", end("`code` #r"))).toEqual({
    trigger: "#",
    start: 7,
    query: "r",
  });
  // Inline code never spans lines: a stray backtick on an earlier line leaves this one prose.
  expect(activeReferenceQuery("a ` b\n#r", end("a ` b\n#r"))).toEqual({
    trigger: "#",
    start: 6,
    query: "r",
  });
});

test("a fenced code block keeps both triggers closed until it is fenced off again", () => {
  expect(activeReferenceQuery("```\n#", end("```\n#"))).toBeUndefined();
  expect(activeReferenceQuery("```ts\nconst x = 1\n@al", end("```ts\nconst x = 1\n@al"))).toBe(
    undefined,
  );
  expect(activeReferenceQuery("```\ncode\n```\n#r", end("```\ncode\n```\n#r"))).toEqual({
    trigger: "#",
    start: 13,
    query: "r",
  });
  // After a closed fence on the same line, an open backtick still starts inline code.
  expect(activeReferenceQuery("```\nx\n``` `y #r", end("```\nx\n``` `y #r"))).toBeUndefined();
});

test("channel suggestions keep every channel whose name contains the query", () => {
  const channels = [
    channel("all"),
    channel("le-agent"),
    channel("prj-daemon"),
    channel("raft-like"),
    channel("raft-research"),
    channel("general"),
    channel("ops"),
  ];
  const ranked = filterChannelSuggestions(channels, "a");
  expect(ranked.map((item) => item.name)).toEqual([
    "all",
    "general",
    "le-agent",
    "prj-daemon",
    "raft-like",
    "raft-research",
  ]);
  expect(filterChannelSuggestions(channels, "zzz")).toEqual([]);
});

test("channel suggestions put the current conversation's channel first when it matches", () => {
  const channels = [channel("design"), channel("product"), channel("random")];
  expect(
    filterChannelSuggestions(channels, "", { currentChannelId: "channel-random" }).map(
      (item) => item.name,
    ),
  ).toEqual(["random", "design", "product"]);
  // A current channel that does not match stays out; a DM (no channel id) changes nothing.
  expect(
    filterChannelSuggestions(channels, "e", { currentChannelId: "channel-random" }).map(
      (item) => item.name,
    ),
  ).toEqual(["design"]);
  expect(
    filterChannelSuggestions(channels, "", { currentChannelId: "dm-conversation" }).map(
      (item) => item.name,
    ),
  ).toEqual(["design", "product", "random"]);
});

test("channel suggestions keep archived channels and their fields", () => {
  const archived = channel("old-launch", "The spring launch", true);
  expect(filterChannelSuggestions([archived], "launch")).toEqual([archived]);
});

test("channel suggestions are capped by limit, 8 by default", () => {
  const many = Array.from({ length: 10 }, (_, index) => channel(`c${index}`));
  expect(filterChannelSuggestions(many, "")).toHaveLength(8);
  expect(filterChannelSuggestions(many, "", { limit: 3 }).map((item) => item.name)).toEqual([
    "c0",
    "c1",
    "c2",
  ]);
});

test("insertReference replaces the typed token and leaves the caret after a trailing space", () => {
  expect(insertReference("see #r later", 4, 6, "#random")).toEqual({
    value: "see #random  later",
    caret: 12,
  });
  expect(insertReference("hi @al", 3, 6, "@alice")).toEqual({ value: "hi @alice ", caret: 10 });
  expect(insertReference("#", 0, 1, "#product")).toEqual({ value: "#product ", caret: 9 });
});
