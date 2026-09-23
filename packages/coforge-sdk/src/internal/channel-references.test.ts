import { expect, test } from "bun:test";
import { channelReferenceToken, replaceChannelReferenceTokens } from "./channel-references";

const PRODUCT = "33333333-3333-4333-8333-333333333333";
const RANDOM = "44444444-4444-4444-8444-444444444444";

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
