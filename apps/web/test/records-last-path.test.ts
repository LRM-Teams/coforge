import { expect, test } from "bun:test";

import {
  DEFAULT_RECORDS_NAV_HREF,
  recallRecordsLastPath,
  recordsNavHref,
  rememberRecordsLastPath,
  sanitizeRecordsLastPath,
} from "#src/features/records/records-last-path";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.has(key) ? values.get(key)! : null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

test("sanitizeRecordsLastPath accepts Records paths with optional search", () => {
  expect(sanitizeRecordsLastPath("/records")).toBe("/records");
  expect(sanitizeRecordsLastPath("/records?tab=weekly")).toBe("/records?tab=weekly");
  expect(sanitizeRecordsLastPath("/records?tab=notes")).toBe("/records?tab=notes");
  expect(sanitizeRecordsLastPath("/records/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe(
    "/records/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  );
  expect(sanitizeRecordsLastPath("/records/settings?section=templates")).toBe(
    "/records/settings?section=templates",
  );
  expect(sanitizeRecordsLastPath("/records/stats?year=2026&month=9")).toBe(
    "/records/stats?year=2026&month=9",
  );
});

test("sanitizeRecordsLastPath rejects open redirects and non-Records paths", () => {
  expect(sanitizeRecordsLastPath("/agents")).toBeUndefined();
  expect(sanitizeRecordsLastPath("/records-extra")).toBeUndefined();
  expect(sanitizeRecordsLastPath("//evil.example/records")).toBeUndefined();
  expect(sanitizeRecordsLastPath("/records/../agents")).toBeUndefined();
  expect(sanitizeRecordsLastPath("/records?tab=weekly://x")).toBeUndefined();
  expect(sanitizeRecordsLastPath("https://example.com/records")).toBeUndefined();
  expect(sanitizeRecordsLastPath("/records\\\nhack")).toBeUndefined();
  expect(sanitizeRecordsLastPath(null)).toBeUndefined();
  expect(sanitizeRecordsLastPath(`/records/${"x".repeat(400)}`)).toBeUndefined();
});

test("remember then recall restores the last path for that Workspace", () => {
  const storage = memoryStorage();
  rememberRecordsLastPath(
    "ws-1",
    "/records/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?tab=weekly",
    storage,
  );
  expect(recallRecordsLastPath("ws-1", storage)).toBe(
    "/records/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?tab=weekly",
  );
  expect(recallRecordsLastPath("ws-2", storage)).toBeUndefined();
});

test("remember ignores unsafe paths and leaves prior recall untouched", () => {
  const storage = memoryStorage();
  rememberRecordsLastPath("ws-1", "/records/settings", storage);
  rememberRecordsLastPath("ws-1", "/agents", storage);
  expect(recallRecordsLastPath("ws-1", storage)).toBe("/records/settings");
});

test("recordsNavHref falls back to the weekly landing entry when nothing is remembered", () => {
  const storage = memoryStorage();
  expect(recordsNavHref("ws-1", storage)).toBe(DEFAULT_RECORDS_NAV_HREF);
  rememberRecordsLastPath("ws-1", "/records/stats?year=2026&month=9", storage);
  expect(recordsNavHref("ws-1", storage)).toBe("/records/stats?year=2026&month=9");
});
