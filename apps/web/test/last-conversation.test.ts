import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  landingConversation,
  rememberConversation,
  rememberedConversation,
} from "#src/features/conversations/last-conversation";

function stubLocalStorage() {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
    clear: () => {
      store.clear();
    },
    key: () => null,
    get length() {
      return store.size;
    },
  };
}

const channels = [
  { id: "c0", joined: false, archived: false },
  { id: "c1", joined: true, archived: false },
  { id: "c2", joined: true, archived: false },
  { id: "c3", joined: true, archived: true },
];
const lists = { channels, agentIds: ["a1"] };

describe("the conversation Chat reopens", () => {
  beforeEach(stubLocalStorage);
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  test("is the channel, direct message, or Saved view opened last in this Workspace", () => {
    rememberConversation("w1", "/messages/channels/c2");
    expect(rememberedConversation("w1")).toEqual({ channelId: "c2" });
    rememberConversation("w1", "/messages/a1");
    expect(rememberedConversation("w1")).toEqual({ agentId: "a1" });
    rememberConversation("w1", "/messages/saved");
    expect(rememberedConversation("w1")).toEqual({ view: "saved" });
  });

  test("is kept per Workspace", () => {
    rememberConversation("w1", "/messages/channels/c1");
    rememberConversation("w2", "/messages/channels/c2");
    expect(rememberedConversation("w1")).toEqual({ channelId: "c1" });
    expect(rememberedConversation("w2")).toEqual({ channelId: "c2" });
  });

  test("ignores pages that are not a conversation", () => {
    rememberConversation("w1", "/messages/channels/c1");
    rememberConversation("w1", "/messages");
    rememberConversation("w1", "/agents/a1");
    expect(rememberedConversation("w1")).toEqual({ channelId: "c1" });
  });

  test("is nothing before any conversation was opened or without storage", () => {
    expect(rememberedConversation("w1")).toBeUndefined();
    // A private window or SSR can have no localStorage at all.
    Reflect.deleteProperty(globalThis, "localStorage");
    rememberConversation("w1", "/messages/channels/c1");
    expect(rememberedConversation("w1")).toBeUndefined();
  });
});

describe("where Chat lands", () => {
  test("is the remembered conversation while it is still listed", () => {
    expect(landingConversation({ channelId: "c2" }, lists)).toEqual({ channelId: "c2" });
    expect(landingConversation({ channelId: "c0" }, lists)).toEqual({ channelId: "c0" });
    expect(landingConversation({ agentId: "a1" }, lists)).toEqual({ agentId: "a1" });
    expect(landingConversation({ view: "saved" }, lists)).toEqual({ view: "saved" });
  });

  test("falls back to the first joined channel once the remembered one is gone", () => {
    expect(landingConversation({ channelId: "deleted" }, lists)).toEqual({ channelId: "c1" });
    expect(landingConversation({ channelId: "c3" }, lists)).toEqual({ channelId: "c1" });
    expect(landingConversation({ agentId: "removed" }, lists)).toEqual({ channelId: "c1" });
    expect(landingConversation(undefined, lists)).toEqual({ channelId: "c1" });
  });

  test("is nothing without a remembered conversation or a joined channel", () => {
    expect(
      landingConversation(undefined, { channels: [channels[0]!, channels[3]!], agentIds: [] }),
    ).toBeUndefined();
  });
});
