import { describe, expect, test } from "bun:test";

import {
  dragCarriesFiles,
  fileFromDropItems,
  filesFromPaste,
  IME_ENTER_GUARD_MS,
  shouldSendOnEnter,
} from "@/features/conversations/composer-behavior";

const baseEnter = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 };
const noComposition = { lastCompositionEndAt: null, now: 0 };

describe("shouldSendOnEnter", () => {
  test("sends on plain Enter outside composition", () => {
    expect(shouldSendOnEnter(baseEnter, noComposition)).toBe(true);
  });

  test("keeps Shift+Enter as a newline", () => {
    expect(shouldSendOnEnter({ ...baseEnter, shiftKey: true }, noComposition)).toBe(false);
  });

  test("ignores non-Enter keys", () => {
    expect(shouldSendOnEnter({ ...baseEnter, key: "a" }, noComposition)).toBe(false);
  });

  test("ignores Enter while nativeEvent.isComposing is true", () => {
    expect(shouldSendOnEnter({ ...baseEnter, isComposing: true }, noComposition)).toBe(false);
  });

  test("ignores Enter carrying the legacy keyCode 229 IME marker", () => {
    expect(shouldSendOnEnter({ ...baseEnter, keyCode: 229 }, noComposition)).toBe(false);
  });

  test("ignores Enter fired just after compositionend (Safari)", () => {
    const composition = { lastCompositionEndAt: 1000, now: 1000 + IME_ENTER_GUARD_MS - 1 };
    expect(shouldSendOnEnter(baseEnter, composition)).toBe(false);
  });

  test("sends Enter once the compositionend guard window has elapsed", () => {
    const composition = { lastCompositionEndAt: 1000, now: 1000 + IME_ENTER_GUARD_MS };
    expect(shouldSendOnEnter(baseEnter, composition)).toBe(true);
  });
});

function fileItem(file: File) {
  return { kind: "file", getAsFile: () => file };
}

function textItem() {
  return { kind: "string", getAsFile: () => null };
}

describe("filesFromPaste", () => {
  test("returns no files for a text-only paste", () => {
    expect(filesFromPaste({ files: [], items: [textItem()] })).toEqual([]);
  });

  test("returns no files when clipboardData is missing", () => {
    expect(filesFromPaste(null)).toEqual([]);
    expect(filesFromPaste(undefined)).toEqual([]);
  });

  test("reads files from clipboardData.files", () => {
    const file = new File(["contents"], "photo.png", { type: "image/png" });
    expect(filesFromPaste({ files: [file], items: [] })).toEqual([file]);
  });

  test("falls back to items with kind 'file' (e.g. a pasted screenshot)", () => {
    const file = new File(["contents"], "screenshot.png", { type: "image/png" });
    expect(filesFromPaste({ files: [], items: [textItem(), fileItem(file)] })).toEqual([file]);
  });

  test("prefers clipboardData.files over items when both are present", () => {
    const fromFiles = new File(["a"], "a.txt");
    const fromItems = new File(["b"], "b.txt");
    expect(filesFromPaste({ files: [fromFiles], items: [fileItem(fromItems)] })).toEqual([
      fromFiles,
    ]);
  });
});

describe("dragCarriesFiles", () => {
  test("is true when the native drag types include 'Files'", () => {
    expect(dragCarriesFiles(["Files"])).toBe(true);
    expect(dragCarriesFiles(["text/plain", "Files"])).toBe(true);
  });

  test("is false for a text or URL drag with no 'Files' type", () => {
    expect(dragCarriesFiles(["text/plain"])).toBe(false);
    expect(dragCarriesFiles(["text/uri-list", "text/plain"])).toBe(false);
  });

  test("is false when there are no drag types", () => {
    expect(dragCarriesFiles([])).toBe(false);
    expect(dragCarriesFiles(null)).toBe(false);
    expect(dragCarriesFiles(undefined)).toBe(false);
  });
});

describe("fileFromDropItems", () => {
  test("returns undefined for a text-only drop", () => {
    expect(fileFromDropItems({ files: [], items: [textItem()] })).toBeUndefined();
  });

  test("returns undefined when dataTransfer is missing", () => {
    expect(fileFromDropItems(null)).toBeUndefined();
    expect(fileFromDropItems(undefined)).toBeUndefined();
  });

  test("reads the file from dataTransfer.files", () => {
    const file = new File(["contents"], "photo.png", { type: "image/png" });
    expect(fileFromDropItems({ files: [file], items: [] })).toBe(file);
  });

  test("falls back to items with kind 'file'", () => {
    const file = new File(["contents"], "report.pdf", { type: "application/pdf" });
    expect(fileFromDropItems({ files: [], items: [textItem(), fileItem(file)] })).toBe(file);
  });

  test("keeps only the first file when several are dropped, matching paste's single-attachment model", () => {
    const first = new File(["a"], "first.txt");
    const second = new File(["b"], "second.txt");
    expect(fileFromDropItems({ files: [first, second], items: [] })).toBe(first);
  });
});
