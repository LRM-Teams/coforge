import { afterEach, expect, test } from "bun:test";

import {
  DEVICE_FLAG_HIDDEN,
  readDeviceFlag,
  writeDeviceFlag,
} from "#src/features/settings/device-flag";
import { RAIL_LABELS_BOOT } from "#src/features/settings/rail-labels";
import { MESSAGE_WIDTH_BOOT } from "#src/features/settings/message-width";

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

function stubLocalStorage(value: unknown) {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => value });
}

function memoryStorage(seed: Record<string, string> = {}) {
  const items = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    items,
  };
}

test("reads an unset flag as shown, and only the hidden value as hidden", () => {
  stubLocalStorage(memoryStorage());
  expect(readDeviceFlag("coforge-x")).toBe(true);
  stubLocalStorage(memoryStorage({ "coforge-x": DEVICE_FLAG_HIDDEN }));
  expect(readDeviceFlag("coforge-x")).toBe(false);
  stubLocalStorage(memoryStorage({ "coforge-x": "show" }));
  expect(readDeviceFlag("coforge-x")).toBe(true);
});

test("reads a blocked or absent storage as shown rather than throwing", () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("blocked");
    },
  });
  expect(readDeviceFlag("coforge-x")).toBe(true);
  stubLocalStorage(undefined);
  expect(readDeviceFlag("coforge-x")).toBe(true);
});

test("writes show/hide and stays quiet when storage refuses", () => {
  const storage = memoryStorage();
  stubLocalStorage(storage);
  writeDeviceFlag("coforge-x", false);
  expect(storage.items.get("coforge-x")).toBe(DEVICE_FLAG_HIDDEN);
  writeDeviceFlag("coforge-x", true);
  expect(storage.items.get("coforge-x")).toBe("show");

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("blocked");
    },
  });
  expect(() => writeDeviceFlag("coforge-x", true)).not.toThrow();
});

test("the rail-labels boot fragment agrees with the module about the hidden value", () => {
  expect(RAIL_LABELS_BOOT).toContain("coforge-rail-labels");
  expect(RAIL_LABELS_BOOT).toContain(`"${DEVICE_FLAG_HIDDEN}"`);
  expect(RAIL_LABELS_BOOT).toContain("rail-labels-hidden");
});

test("the message-width boot fragment carries the same key, stored value and class the reader uses", () => {
  expect(MESSAGE_WIDTH_BOOT).toBe(
    'if(localStorage.getItem("coforge-message-width")==="full"){document.documentElement.classList.add("message-full-width")}',
  );
});
