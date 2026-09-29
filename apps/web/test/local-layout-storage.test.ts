import { afterEach, describe, expect, test } from "bun:test";

import { localLayoutStorage } from "#src/features/conversations/local-layout-storage";

const key = "coforge-local-layout-storage-test";

afterEach(() => {
  // @ts-expect-error clear test stub
  delete globalThis.localStorage;
});

describe("localLayoutStorage", () => {
  test("getItem and setItem do not throw when localStorage is absent", () => {
    // @ts-expect-error intentional deletion for SSR regression
    delete globalThis.localStorage;
    expect(localLayoutStorage.getItem(key)).toBeNull();
    expect(() => localLayoutStorage.setItem(key, "{}")).not.toThrow();
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
    localLayoutStorage.setItem(key, '{"main":60}');
    expect(localLayoutStorage.getItem(key)).toBe('{"main":60}');
  });
});
