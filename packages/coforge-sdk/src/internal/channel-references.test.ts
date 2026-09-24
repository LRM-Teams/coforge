import { expect, test } from "bun:test";
import {
  THREAD_REFERENCE_PATTERN,
  channelReferenceToken,
  replaceChannelReferenceTokens,
  replaceThreadReferenceTokens,
  threadReferenceToken,
} from "./channel-references";

const PRODUCT = "33333333-3333-4333-8333-333333333333";
const RANDOM = "44444444-4444-4444-8444-444444444444";
const ROOT = "abcdef12-3456-4789-8abc-def012345678";

test("a channel token stores the lower-cased id and the channel's name", () => {
  expect(channelReferenceToken(PRODUCT.toUpperCase(), "product")).toBe(
    `<@channel:${PRODUCT}:product>`,
  );
});

test("the reader turns a channel token into #name: the current name when known, else the stored one", () => {
  const body = `in ${channelReferenceToken(PRODUCT, "product")} and ${channelReferenceToken(RANDOM, "random")}`;
  expect(replaceChannelReferenceTokens(body)).toBe("in #product and #random");
  expect(replaceChannelReferenceTokens(body, (id) => (id === PRODUCT ? "launch" : undefined))).toBe(
    "in #launch and #random",
  );
});

test("text that only looks like a channel token is left as written", () => {
  expect(replaceChannelReferenceTokens("<@channel:not-a-uuid:product> and #product")).toBe(
    "<@channel:not-a-uuid:product> and #product",
  );
});

test("a thread token stores the lower-cased channel and root ids and the channel's name", () => {
  expect(threadReferenceToken(PRODUCT.toUpperCase(), ROOT.toUpperCase(), "product")).toBe(
    `<@thread:${PRODUCT}:${ROOT}:product>`,
  );
});

test("the reader turns a thread token into #name:<first 8 hex of the root>, the form a thread target takes", () => {
  const body = `see ${threadReferenceToken(PRODUCT, ROOT, "product")}.`;
  expect(replaceThreadReferenceTokens(body)).toBe("see #product:abcdef12.");
  expect(replaceThreadReferenceTokens(body, (id) => (id === PRODUCT ? "launch" : undefined))).toBe(
    "see #launch:abcdef12.",
  );
  // A channel token is not a thread token, and the reverse.
  expect(replaceThreadReferenceTokens(channelReferenceToken(PRODUCT, "product"))).toBe(
    channelReferenceToken(PRODUCT, "product"),
  );
  expect(replaceChannelReferenceTokens(body)).toBe(body);
});

test("text that only looks like a thread token is left as written", () => {
  for (const body of [`<@thread:${PRODUCT}:product>`, `<@thread:${PRODUCT}:deadbeef:product>`])
    expect(replaceThreadReferenceTokens(body)).toBe(body);
});

test("the prose thread reference captures the channel name and the message id", () => {
  const read = (text: string) =>
    [...text.matchAll(THREAD_REFERENCE_PATTERN)].map((match) => [match[1], match[2]]);
  expect(read("#product:abc123, #Product:ABCDEF12 and #product:" + ROOT)).toEqual([
    ["product", "abc123"],
    ["Product", "ABCDEF12"],
    ["product", ROOT],
  ]);
  // Too short, too long, or running on into a word: not a thread reference.
  expect(read("#product:abc12 #product:abcdef123 #product:abcdef12x")).toEqual([]);
});
