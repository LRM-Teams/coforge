import { afterEach, expect, test } from "bun:test";

import {
  DEVICE_FLAG_HIDDEN,
  readDeviceFlag,
  writeDeviceFlag,
} from "#src/features/settings/device-flag";
import { RAIL_LABELS_BOOT } from "#src/features/settings/rail-labels";
import { MESSAGE_WIDTH_BOOT } from "#src/features/settings/message-width";
import { HIDE_EMPTY_SIDEBAR_SECTIONS_BOOT } from "#src/features/settings/hide-empty-sidebar-sections";
import { readHideEmptySidebarSections } from "#src/features/settings/hide-empty-sidebar-sections";
import { readMessageFullWidth } from "#src/features/settings/message-width";
import { readRailLabels } from "#src/features/settings/rail-labels";

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

/** Runs one boot fragment the way `__root.tsx` does — as text, against whatever the device stored —
 * and reports the classes it put on <html>. */
function classAddedBy(fragment: string, seed: Record<string, string>): string[] {
  const storage = memoryStorage(seed);
  stubLocalStorage(storage);
  const added: string[] = [];
  const documentStub = {
    documentElement: { classList: { add: (className: string) => void added.push(className) } },
  };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, get: () => documentStub });
  try {
    new Function(fragment)();
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete (globalThis as { document?: unknown }).document;
  }
  return added;
}

/** Every setting that pre-paints: what the device can hold, and which class the reader says that
 *  state deserves. The point of each case is that the script and the reader agree about it — the
 *  fragment is the SSR half of the same rule, so a disagreement shows up as a flash of the wrong
 *  layout, not as a failed read. */
const PRE_PAINTING_SETTINGS = [
  {
    name: "rail labels",
    fragment: RAIL_LABELS_BOOT,
    key: "coforge-rail-labels",
    className: "rail-labels-hidden",
    // the class hides the captions, so it applies when the reader says "do not show"
    classApplies: () => !readRailLabels(),
  },
  {
    name: "hidden empty sidebar sections",
    fragment: HIDE_EMPTY_SIDEBAR_SECTIONS_BOOT,
    key: "coforge-hide-empty-sidebar-sections",
    className: "sidebar-hide-empty",
    // this one is named after hiding, so the reader's true is the class being on
    classApplies: () => readHideEmptySidebarSections(),
  },
  {
    name: "full-width messages",
    fragment: MESSAGE_WIDTH_BOOT,
    key: "coforge-message-width",
    className: "message-full-width",
    classApplies: () => readMessageFullWidth(),
  },
] as const;

test("each pre-paint fragment applies its class exactly when its reader says the setting is on", () => {
  for (const setting of PRE_PAINTING_SETTINGS) {
    const states: Array<Record<string, string>> = [
      {},
      { [setting.key]: "hide" },
      { [setting.key]: "full" },
      { [setting.key]: "show" },
      { [setting.key]: "something-else" },
    ];
    for (const seed of states) {
      stubLocalStorage(memoryStorage(seed));
      const wanted = setting.classApplies();
      const added = classAddedBy(setting.fragment, seed);
      expect({ setting: setting.name, seed, added }).toEqual({
        setting: setting.name,
        seed,
        added: wanted ? [setting.className] : [],
      });
    }
  }
});
