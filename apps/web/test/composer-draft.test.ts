import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  clearComposerDraft,
  composerDraftKey,
  readComposerDraft,
  readComposerDraftPins,
  writeComposerDraft,
  writeComposerDraftPins,
} from "#src/features/conversations/composer-draft";
import type { MentionPin } from "#src/features/conversations/mention-pins";

const ZHANG: MentionPin = { kind: "user", id: "u-zhang", handle: "zhangsan", label: "张三" };
const SCOUT: MentionPin = { kind: "agent", id: "a-scout", handle: "scout", label: "小侦察" };

let items: Map<string, string>;
const hadStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeEach(() => {
  items = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    },
  });
});

afterEach(() => {
  if (hadStorage) Object.defineProperty(globalThis, "localStorage", hadStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("a draft's mention pins are remembered beside its text, per chat and per thread", () => {
  const main = composerDraftKey("chat-a");
  const thread = composerDraftKey("chat-a", "root-1");
  writeComposerDraft(main, "你好 @张三");
  writeComposerDraftPins(main, [ZHANG, SCOUT]);
  expect(readComposerDraft(main)).toBe("你好 @张三");
  expect(readComposerDraftPins(main)).toEqual([ZHANG, SCOUT]);
  expect(readComposerDraftPins(thread)).toEqual([]);
  expect(readComposerDraftPins(composerDraftKey("chat-b"))).toEqual([]);
});

test("a draft written before pins existed reads as text with none", () => {
  const key = composerDraftKey("chat-a");
  items.set(key, "plain text");
  expect(readComposerDraft(key)).toBe("plain text");
  expect(readComposerDraftPins(key)).toEqual([]);
});

test("no pins removes the entry, so a chat without them leaves nothing behind", () => {
  const key = composerDraftKey("chat-a");
  writeComposerDraftPins(key, [ZHANG]);
  writeComposerDraftPins(key, []);
  expect(items.size).toBe(0);
});

test("clearing a draft, as a send does, clears its pins too", () => {
  const key = composerDraftKey("chat-a");
  writeComposerDraft(key, "@张三");
  writeComposerDraftPins(key, [ZHANG]);
  clearComposerDraft(key);
  expect(items.size).toBe(0);
});

test("pins that cannot be read are dropped, and the text is unaffected", () => {
  const key = composerDraftKey("chat-a");
  writeComposerDraft(key, "@张三");
  writeComposerDraftPins(key, [ZHANG]);
  const [pinsKey] = [...items.keys()].filter((each) => each !== key);
  items.set(pinsKey!, "{not json");
  expect(readComposerDraftPins(key)).toEqual([]);
  items.set(pinsKey!, JSON.stringify([{ kind: "user", id: 7 }]));
  expect(readComposerDraftPins(key)).toEqual([]);
  expect(readComposerDraft(key)).toBe("@张三");
});
