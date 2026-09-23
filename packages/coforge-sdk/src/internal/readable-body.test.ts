import { expect, test } from "bun:test";
import { channelReferenceToken } from "./channel-references";
import { mentionToken } from "./mentions";
import { readableBody } from "./readable-body";
import { taskReferenceToken } from "./task-references";

const ADA = "11111111-1111-4111-8111-111111111111";
const GHOST = "99999999-9999-4999-8999-999999999999";
const PRODUCT = "33333333-3333-4333-8333-333333333333";

const mention = (type: "user" | "agent", id: string) =>
  type === "user" && id === ADA ? "ada" : undefined;

test("every stored token reads back as the text a person writes", () => {
  const body = `${mentionToken("user", ADA)} see ${taskReferenceToken(7)} in ${channelReferenceToken(PRODUCT, "product")}`;
  expect(readableBody(body, { mention })).toBe("@ada see task #7 in #product");
});

test("a channel reads under its current name when known, else the name it was stored with", () => {
  const body = `in ${channelReferenceToken(PRODUCT, "product")}`;
  expect(readableBody(body, { mention, channelName: () => "launch" })).toBe("in #launch");
  expect(readableBody(body, { mention, channelName: () => undefined })).toBe("in #product");
});

test("a mention token nobody can resolve stays as written", () => {
  const body = `hi ${mentionToken("agent", GHOST)}`;
  expect(readableBody(body, { mention })).toBe(body);
});

test("a body with no stored token comes back untouched", () => {
  const body = "plain @ada and task #7 and #product";
  expect(readableBody(body, { mention: () => "never" })).toBe(body);
});
