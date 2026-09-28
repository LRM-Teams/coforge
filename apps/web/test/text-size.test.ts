import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { readTextSize, writeTextSize } from "#src/features/settings/text-size";

const STORAGE_KEY = "coforge-text-size";

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

beforeEach(() => {
  globalThis.localStorage = createLocalStorageStub();
  globalThis.document = {
    documentElement: { style: {} },
  } as unknown as Document;
});

afterEach(() => {
  // @ts-expect-error test cleanup
  delete globalThis.localStorage;
  // @ts-expect-error test cleanup
  delete globalThis.document;
});

describe("readTextSize", () => {
  test('defaults to "default" when nothing is stored', () => {
    expect(readTextSize()).toBe("default");
  });

  test('falls back to "default" for an invalid stored value', () => {
    localStorage.setItem(STORAGE_KEY, "not-a-real-value");
    expect(readTextSize()).toBe("default");
  });

  test("returns a valid stored value", () => {
    localStorage.setItem(STORAGE_KEY, "lg");
    expect(readTextSize()).toBe("lg");
  });

  test("does not throw when localStorage is absent", () => {
    // @ts-expect-error intentional deletion for SSR regression
    delete globalThis.localStorage;
    expect(readTextSize()).toBe("default");
  });
});

describe("writeTextSize", () => {
  test("sets the inline root font size and persists the value", () => {
    writeTextSize("xl");
    expect(document.documentElement.style.fontSize).toBe("125%");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("xl");
  });

  test('"default" removes the inline style and clears storage', () => {
    writeTextSize("lg");
    writeTextSize("default");
    expect(document.documentElement.style.fontSize).toBe("");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("does not throw when localStorage is absent", () => {
    // @ts-expect-error intentional deletion for SSR regression
    delete globalThis.localStorage;
    expect(() => writeTextSize("sm")).not.toThrow();
    expect(document.documentElement.style.fontSize).toBe("90%");
  });
});
