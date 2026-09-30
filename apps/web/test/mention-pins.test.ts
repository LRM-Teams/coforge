import { expect, test } from "bun:test";

import type { Mentionable } from "#src/features/conversations/mention-text";
import {
  addMentionPin,
  mentionInsertText,
  mentionPinFor,
  mentionsByLabel,
  NO_PINS,
  pinsInText,
  rewriteMentionPins,
  unpinnedLabelMentions,
  type MentionPin,
} from "#src/features/conversations/mention-pins";

const ZHANG: MentionPin = { kind: "user", id: "u-zhang", handle: "zhangsan", label: "张三" };
const ZHANG_SAN: MentionPin = {
  kind: "user",
  id: "u-zhang-san",
  handle: "zhang-san",
  label: "Zhang San",
};
const ZHANG_FENG: MentionPin = {
  kind: "user",
  id: "u-zhang-feng",
  handle: "zhangsanfeng",
  label: "张三丰",
};
const SCOUT: MentionPin = { kind: "agent", id: "a-scout", handle: "scout", label: "小侦察" };

const binding = (pin: MentionPin) => ({
  type: pin.kind,
  id: pin.id,
  name: pin.handle,
});

test("a picked name is written as its readable label, and pinned by identity", () => {
  const mention: Mentionable = {
    kind: "user",
    id: "u-zhang",
    handle: "zhangsan",
    label: "张三",
    description: "Design",
    mentionScore: 0,
  };
  expect(mentionInsertText(mention)).toBe("@张三");
  expect(mentionPinFor(mention)).toEqual(ZHANG);
});

test("a picked name is rewritten to its handle and reported as a binding", () => {
  expect(rewriteMentionPins("你好 @张三 看看", [ZHANG])).toEqual({
    body: "你好 @zhangsan 看看",
    mentions: [binding(ZHANG)],
  });
});

test("a label that holds a space is rewritten whole", () => {
  expect(rewriteMentionPins("hi @Zhang San, look", [ZHANG_SAN])).toEqual({
    body: "hi @zhang-san, look",
    mentions: [binding(ZHANG_SAN)],
  });
});

test("a name at the start or the end of the text, in brackets or before punctuation, is rewritten", () => {
  expect(rewriteMentionPins("@张三", [ZHANG]).body).toBe("@zhangsan");
  expect(rewriteMentionPins("看一下 @张三", [ZHANG]).body).toBe("看一下 @zhangsan");
  expect(rewriteMentionPins("（@张三），好", [ZHANG]).body).toBe("（@zhangsan），好");
  expect(rewriteMentionPins("x\n@张三\ny", [ZHANG]).body).toBe("x\n@zhangsan\ny");
});

test("a name typed straight after CJK text is still rewritten, as a person types it in Chinese", () => {
  expect(rewriteMentionPins("请@张三 看一下", [ZHANG]).body).toBe("请@zhangsan 看一下");
});

test("a name inside inline or fenced code is left as written and reports no binding", () => {
  expect(rewriteMentionPins("run `@张三` now", [ZHANG])).toEqual({
    body: "run `@张三` now",
    mentions: [],
  });
  expect(rewriteMentionPins("```\n@张三\n```", [ZHANG])).toEqual({
    body: "```\n@张三\n```",
    mentions: [],
  });
});

test("a name in prose is rewritten while the same text in code beside it is not", () => {
  expect(rewriteMentionPins("@张三 `@张三`\n```\n@张三\n```\n@张三", [ZHANG])).toEqual({
    body: "@zhangsan `@张三`\n```\n@张三\n```\n@zhangsan",
    mentions: [binding(ZHANG)],
  });
});

test("a pin whose name is no longer in the text is dropped: nothing is rewritten or bound", () => {
  expect(rewriteMentionPins("你好 张三", [ZHANG])).toEqual({ body: "你好 张三", mentions: [] });
  expect(rewriteMentionPins("你好", [])).toEqual({ body: "你好", mentions: [] });
});

test("a name edited into a longer word is not the pinned name", () => {
  // CJK letters and Latin letters after the label make it a different word.
  expect(rewriteMentionPins("@张三丰", [ZHANG])).toEqual({ body: "@张三丰", mentions: [] });
  expect(rewriteMentionPins("@Zhang Sanchez", [ZHANG_SAN])).toEqual({
    body: "@Zhang Sanchez",
    mentions: [],
  });
  expect(rewriteMentionPins("@Zhang San-x", [ZHANG_SAN])).toEqual({
    body: "@Zhang San-x",
    mentions: [],
  });
  // Text that turns the @ into part of a word (an email address) is no mention either.
  expect(rewriteMentionPins("mail me@张三", [ZHANG])).toEqual({
    body: "mail me@张三",
    mentions: [],
  });
});

test("a name is matched case-sensitively, as the picker wrote it", () => {
  expect(rewriteMentionPins("@zhang san", [ZHANG_SAN])).toEqual({
    body: "@zhang san",
    mentions: [],
  });
});

test("the longer of two names that begin alike takes the text they share", () => {
  const zhang: MentionPin = { kind: "user", id: "u-z", handle: "zhang", label: "Zhang" };
  expect(rewriteMentionPins("@Zhang San hi", [zhang, ZHANG_SAN]).body).toBe("@zhang-san hi");
  expect(rewriteMentionPins("@Zhang hi", [zhang, ZHANG_SAN]).body).toBe("@zhang hi");
  // A shorter name that is only the front of a longer word stays out of it (CJK).
  expect(rewriteMentionPins("@张三丰 @张三 ", [ZHANG, ZHANG_FENG])).toEqual({
    body: "@zhangsanfeng @zhangsan ",
    mentions: [binding(ZHANG_FENG), binding(ZHANG)],
  });
});

test("several names are rewritten, and bound in the order they appear", () => {
  expect(rewriteMentionPins("@小侦察 请让 @张三 看看", [ZHANG, SCOUT])).toEqual({
    body: "@scout 请让 @zhangsan 看看",
    mentions: [binding(SCOUT), binding(ZHANG)],
  });
});

test("one person mentioned twice is rewritten both times and bound once", () => {
  expect(rewriteMentionPins("@张三 和 @张三", [ZHANG])).toEqual({
    body: "@zhangsan 和 @zhangsan",
    mentions: [binding(ZHANG)],
  });
});

test("two people who share a label are paired with their names in the order they were picked", () => {
  const other: MentionPin = { kind: "user", id: "u-zhang-2", handle: "zhangsan2", label: "张三" };
  expect(rewriteMentionPins("@张三 然后 @张三", [ZHANG, other])).toEqual({
    body: "@zhangsan 然后 @zhangsan2",
    mentions: [binding(ZHANG), binding(other)],
  });
});

test("two people who share a label are not guessed at when the text no longer holds both names", () => {
  const other: MentionPin = { kind: "user", id: "u-zhang-2", handle: "zhangsan2", label: "张三" };
  // One name deleted: which of the two is left cannot be told, so it is sent as typed.
  expect(rewriteMentionPins("@张三", [ZHANG, other])).toEqual({ body: "@张三", mentions: [] });
  // A name typed by hand on top of the two picked ones.
  expect(rewriteMentionPins("@张三 @张三 @张三", [ZHANG, other])).toEqual({
    body: "@张三 @张三 @张三",
    mentions: [],
  });
});

test("a pin for an Agent is rewritten the same way", () => {
  expect(rewriteMentionPins("@小侦察 go", [SCOUT])).toEqual({
    body: "@scout go",
    mentions: [binding(SCOUT)],
  });
});

test("a body with nothing to rewrite comes back as it is", () => {
  const body = "no mentions here";
  expect(rewriteMentionPins(body, [ZHANG]).body).toBe(body);
});

test("a person picked again replaces their earlier pin instead of adding a second", () => {
  const renamed = { ...ZHANG, label: "张三丰" };
  expect(addMentionPin([ZHANG, SCOUT], renamed)).toEqual([SCOUT, renamed]);
  const same = [ZHANG, SCOUT];
  expect(addMentionPin(same, ZHANG)).toBe(same);
});

test("only the pins whose names are still in the text are kept with a message", () => {
  expect(pinsInText("@小侦察 走", [ZHANG, SCOUT])).toEqual([SCOUT]);
  expect(pinsInText("`@张三`", [ZHANG])).toEqual([]);
  expect(pinsInText("hello", [])).toEqual([]);
});

test("the pins are kept in step with the text: unchanged when every name is there, none when none is", () => {
  const both = [ZHANG, SCOUT];
  expect(pinsInText("@张三 @小侦察", both)).toBe(both);
  expect(pinsInText("hi", both)).toBe(NO_PINS);
});

test("one of two people who read alike, picked after the other's name was deleted, is the one bound", () => {
  const otherZhang: MentionPin = { ...ZHANG, id: "u-zhang-2", handle: "zhangsan-2" };
  // Picked 张三 (the first), then deleted the name; the composer keeps pins in step with the text.
  const afterDelete = pinsInText("hi ", [ZHANG]);
  // Picked the other 张三.
  const pins = addMentionPin(afterDelete, otherZhang);
  expect(rewriteMentionPins("hi @张三 ", pins)).toEqual({
    body: "hi @zhangsan-2 ",
    mentions: [binding(otherZhang)],
  });
});

function candidate(
  kind: Mentionable["kind"],
  id: string,
  handle: string,
  label: string,
  description = "",
): Mentionable {
  return { kind, id, handle, label, description, mentionScore: 0 };
}

const people = [
  candidate("user", "u-zhang", "zhangsan", "张三", "Design"),
  candidate("user", "u-lisi", "lisi", "李四"),
  candidate("agent", "a-scout", "scout", "小侦察"),
  candidate("agent", "a-bob", "bob", "bob"),
];

test("a member's name typed by hand, with nothing picked, is offered back as who was meant", () => {
  expect(unpinnedLabelMentions("你好 @张三 看看", [], mentionsByLabel(people))).toEqual([
    { label: "张三", candidates: [people[0]] },
  ]);
});

test("a name that was picked is not offered again, and a second unpicked one still is", () => {
  const found = unpinnedLabelMentions("@张三 和 @李四", [ZHANG], mentionsByLabel(people));
  expect(found.map((mention) => mention.label)).toEqual(["李四"]);
});

test("names in code, glued to letters, or with a longer word after are not hand-typed mentions", () => {
  expect(unpinnedLabelMentions("`@张三`", [], mentionsByLabel(people))).toEqual([]);
  expect(unpinnedLabelMentions("```\n@张三\n```", [], mentionsByLabel(people))).toEqual([]);
  expect(unpinnedLabelMentions("mail me@张三", [], mentionsByLabel(people))).toEqual([]);
  expect(unpinnedLabelMentions("@张三丰", [], mentionsByLabel(people))).toEqual([]);
});

test("a handle typed as the label is not offered: it already names the member", () => {
  expect(unpinnedLabelMentions("@bob hi", [], mentionsByLabel(people))).toEqual([]);
});

test("every candidate that shares the typed label is offered, in the list's order", () => {
  const twin = candidate("user", "u-zhang-2", "zhangsan2", "张三", "Sales");
  const found = unpinnedLabelMentions("@张三", [], mentionsByLabel([...people, twin]));
  expect(found).toEqual([{ label: "张三", candidates: [people[0], twin] }]);
});

test("mentions are offered in the order the names appear, each label once", () => {
  const found = unpinnedLabelMentions("@李四 然后 @张三 再 @李四", [], mentionsByLabel(people));
  expect(found.map((mention) => mention.label)).toEqual(["李四", "张三"]);
});

test("a text with no @ finds nothing to offer", () => {
  expect(unpinnedLabelMentions("张三 李四", [], mentionsByLabel(people))).toEqual([]);
});

test("a person in both lists while they refetch is one candidate, and a name that is its own handle is left out", () => {
  const byLabel = mentionsByLabel([...people, people[0]!]);
  expect(byLabel.get("张三")).toEqual([people[0]]);
  expect(byLabel.has("bob")).toBe(false);
});
