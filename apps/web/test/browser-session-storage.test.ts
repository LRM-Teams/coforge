import { afterEach, expect, test } from "bun:test";

import { browserSessionStorage } from "#src/features/records/browser-session-storage";

const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "sessionStorage", original);
  else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
});

function stubSessionStorage(value: unknown) {
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: () => value });
}

test("returns undefined where there is no sessionStorage at all", () => {
  stubSessionStorage(undefined);
  expect(browserSessionStorage()).toBeUndefined();
});

test("returns undefined when even reading sessionStorage throws (blocked storage)", () => {
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get() {
      throw new Error("blocked");
    },
  });
  expect(browserSessionStorage()).toBeUndefined();
});

test("returns the storage when there is one", () => {
  const fake = { getItem: () => null, setItem: () => {} };
  stubSessionStorage(fake);
  expect(browserSessionStorage()).toBe(fake);
});
