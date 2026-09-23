import { beforeEach, describe, expect, test } from "bun:test";

import {
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

const available = { channelIds: ["c1", "c2"], agentIds: ["a1"] };

describe("the conversation Chat reopens", () => {
  beforeEach(stubLocalStorage);

  test("is the channel, direct message, or Saved view opened last in this Workspace", () => {
    rememberConversation("w1", "/messages/channels/c2");
    expect(rememberedConversation("w1", available)).toEqual({ channelId: "c2" });
    rememberConversation("w1", "/messages/a1");
    expect(rememberedConversation("w1", available)).toEqual({ agentId: "a1" });
    rememberConversation("w1", "/messages/saved");
    expect(rememberedConversation("w1", available)).toEqual({ view: "saved" });
  });

  test("is kept per Workspace", () => {
    rememberConversation("w1", "/messages/channels/c1");
    rememberConversation("w2", "/messages/channels/c2");
    expect(rememberedConversation("w1", available)).toEqual({ channelId: "c1" });
    expect(rememberedConversation("w2", available)).toEqual({ channelId: "c2" });
  });

  test("ignores pages that are not a conversation", () => {
    rememberConversation("w1", "/messages/channels/c1");
    rememberConversation("w1", "/messages");
    rememberConversation("w1", "/agents/a1");
    expect(rememberedConversation("w1", available)).toEqual({ channelId: "c1" });
  });

  test("is forgotten once the conversation is gone from the list", () => {
    rememberConversation("w1", "/messages/channels/deleted");
    expect(rememberedConversation("w1", available)).toBeUndefined();
    rememberConversation("w1", "/messages/removed-agent");
    expect(rememberedConversation("w1", available)).toBeUndefined();
  });

  test("is nothing before any conversation was opened or without storage", () => {
    expect(rememberedConversation("w1", available)).toBeUndefined();
    // A private window or SSR can have no localStorage at all.
    Reflect.deleteProperty(globalThis, "localStorage");
    rememberConversation("w1", "/messages/channels/c1");
    expect(rememberedConversation("w1", available)).toBeUndefined();
  });
});
