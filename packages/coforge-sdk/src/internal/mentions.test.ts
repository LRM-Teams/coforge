import { expect, test } from "bun:test";
import { isValidMentionSelectorArray, mentionsInContent, parseMentionSelector } from "./mentions";

test("parses a human mention selector as type user", () => {
  expect(parseMentionSelector("human:11111111-1111-4111-8111-111111111111:ada")).toEqual({
    type: "user",
    id: "11111111-1111-4111-8111-111111111111",
    name: "ada",
  });
});

test("parses an agent mention selector", () => {
  expect(parseMentionSelector("agent:22222222-2222-4222-8222-222222222222:helper")).toEqual({
    type: "agent",
    id: "22222222-2222-4222-8222-222222222222",
    name: "helper",
  });
});

test("lowercases the actor uuid", () => {
  expect(parseMentionSelector("human:11111111-1111-4111-8111-111111111111:ada")?.id).toBe(
    "11111111-1111-4111-8111-111111111111",
  );
  expect(parseMentionSelector("human:11111111-1111-4111-8111-111111111111:ada")?.id).toBe(
    parseMentionSelector("human:11111111-1111-4111-8111-111111111111:ada")?.id.toLowerCase(),
  );
});

test("rejects an unknown selector kind", () => {
  expect(parseMentionSelector("bot:11111111-1111-4111-8111-111111111111:ada")).toBeUndefined();
});

test("rejects a non-uuid actor id", () => {
  expect(parseMentionSelector("human:not-a-uuid:ada")).toBeUndefined();
});

test("rejects a handle with an uppercase character", () => {
  expect(parseMentionSelector("human:11111111-1111-4111-8111-111111111111:Ada")).toBeUndefined();
});

test("rejects a handle over 128 characters", () => {
  const longHandle = "a".repeat(129);
  expect(
    parseMentionSelector(`human:11111111-1111-4111-8111-111111111111:${longHandle}`),
  ).toBeUndefined();
});

test("rejects a value with the wrong number of segments", () => {
  expect(parseMentionSelector("human:11111111-1111-4111-8111-111111111111")).toBeUndefined();
});

test("finds a plain @handle in content", () => {
  expect(mentionsInContent("hi @ada, please review").has("ada")).toBe(true);
});

test("ignores an @handle inside a fenced code block", () => {
  expect(mentionsInContent("```\n@ada\n```").has("ada")).toBe(false);
});

test("ignores an @handle inside inline code", () => {
  expect(mentionsInContent("see `@ada` in the log").has("ada")).toBe(false);
});

test("still finds an @handle outside a fenced code block in the same message", () => {
  const present = mentionsInContent("@ada please see:\n```\n@helper\n```");
  expect(present.has("ada")).toBe(true);
  expect(present.has("helper")).toBe(false);
});

test("MENTION_PATTERN is reusable across repeated matchAll calls (no shared lastIndex state)", () => {
  expect(mentionsInContent("@ada hi").has("ada")).toBe(true);
  expect(mentionsInContent("@bea hi").has("bea")).toBe(true);
  expect(mentionsInContent("@ada hi").has("ada")).toBe(true);
});

test("isValidMentionSelectorArray accepts a well-formed array", () => {
  expect(
    isValidMentionSelectorArray([
      { type: "user", id: "11111111-1111-4111-8111-111111111111", name: "ada" },
      { type: "agent", id: "22222222-2222-4222-8222-222222222222", name: "helper" },
    ]),
  ).toBe(true);
});

test("isValidMentionSelectorArray rejects a non-array", () => {
  expect(isValidMentionSelectorArray("not-an-array")).toBe(false);
  expect(isValidMentionSelectorArray(undefined)).toBe(false);
});

test("isValidMentionSelectorArray rejects an array longer than the max", () => {
  const mention = { type: "user", id: "11111111-1111-4111-8111-111111111111", name: "ada" };
  expect(isValidMentionSelectorArray(Array.from({ length: 33 }, () => mention))).toBe(false);
  expect(isValidMentionSelectorArray(Array.from({ length: 32 }, () => mention))).toBe(true);
});

test("isValidMentionSelectorArray rejects a non-uuid id, an invalid type, or a bad handle", () => {
  expect(isValidMentionSelectorArray([{ type: "user", id: "not-a-uuid", name: "ada" }])).toBe(
    false,
  );
  expect(
    isValidMentionSelectorArray([
      { type: "human", id: "11111111-1111-4111-8111-111111111111", name: "ada" },
    ]),
  ).toBe(false);
  expect(
    isValidMentionSelectorArray([
      { type: "user", id: "11111111-1111-4111-8111-111111111111", name: "Ada" },
    ]),
  ).toBe(false);
});
