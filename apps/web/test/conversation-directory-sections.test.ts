import { afterEach, describe, expect, test } from "bun:test";

import {
  readCollapsedSections,
  writeCollapsedSections,
} from "@/features/conversations/directory-sections";

function stubLocalStorage(initial?: string) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set("coforge-chat-sections-collapsed", initial);
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
  return store;
}

/** `delete globalThis.localStorage` needs a type-check suppression; this does not. */
function removeLocalStorage() {
  Reflect.deleteProperty(globalThis, "localStorage");
}

afterEach(removeLocalStorage);

describe("Chat sidebar section collapse state", () => {
  test("reads nothing collapsed during SSR, where localStorage does not exist", () => {
    removeLocalStorage();
    expect(readCollapsedSections()).toEqual([]);
    expect(() => writeCollapsedSections(["channels"])).not.toThrow();
  });

  test("round-trips a collapsed section", () => {
    stubLocalStorage();
    writeCollapsedSections(["agents"]);
    expect(readCollapsedSections()).toEqual(["agents"]);
  });

  test("an empty store means both groups are expanded", () => {
    stubLocalStorage();
    expect(readCollapsedSections()).toEqual([]);
  });

  test("ignores malformed or unknown stored values instead of collapsing the sidebar", () => {
    stubLocalStorage("not json");
    expect(readCollapsedSections()).toEqual([]);
    stubLocalStorage('{"channels":true}');
    expect(readCollapsedSections()).toEqual([]);
    stubLocalStorage('["channels","projects"]');
    expect(readCollapsedSections()).toEqual(["channels"]);
  });
});
