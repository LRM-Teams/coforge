import { afterEach, describe, expect, test } from "bun:test";

import { conversationLayoutStorage } from "@/features/conversations/layout-storage";

const key = "coforge-conversation-layout-storage-test";

afterEach(() => {
  // @ts-expect-error clear test stub
  delete globalThis.localStorage;
});

describe("conversationLayoutStorage", () => {
  test("getItem and setItem do not throw when localStorage is absent", () => {
    // @ts-expect-error intentional deletion for SSR regression
    delete globalThis.localStorage;
    expect(conversationLayoutStorage.getItem(key)).toBeNull();
    expect(() => conversationLayoutStorage.setItem(key, "{}")).not.toThrow();
  });

  test("delegates to localStorage when available", () => {
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
    conversationLayoutStorage.setItem(key, '{"main":60}');
    expect(conversationLayoutStorage.getItem(key)).toBe('{"main":60}');
  });
});
