import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  removeFileQuietly,
  runSchtasks,
  windowsTaskUserId,
  writeUtf16XmlFile,
} from "#src/platform/windows-scheduled-task";

describe("windowsTaskUserId", () => {
  test("prefers DOMAIN\\user when the environment supplies both halves", () => {
    expect(windowsTaskUserId({ USERDOMAIN: "ACME", USERNAME: "ada" }, "fallback")).toBe(
      "ACME\\ada",
    );
  });

  test("trims both halves, and falls back when either is missing or blank", () => {
    expect(windowsTaskUserId({ USERDOMAIN: " ACME ", USERNAME: " ada " }, "fallback")).toBe(
      "ACME\\ada",
    );
    expect(windowsTaskUserId({ USERNAME: "ada" }, "fallback")).toBe("fallback");
    expect(windowsTaskUserId({ USERDOMAIN: "ACME" }, "fallback")).toBe("fallback");
    expect(windowsTaskUserId({ USERDOMAIN: "   ", USERNAME: "ada" }, "fallback")).toBe("fallback");
    expect(windowsTaskUserId({}, "fallback")).toBe("fallback");
  });
});

describe("writeUtf16XmlFile", () => {
  test("writes the BOM `schtasks /Create /XML` detects, then the content as UTF-16LE", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coforge-scheduled-task-"));
    try {
      const path = join(directory, "task.xml");
      await writeUtf16XmlFile(path, "<Task/>");
      const bytes = await readFile(path);
      expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
      expect(bytes.subarray(2).toString("utf16le")).toBe("<Task/>");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("removeFileQuietly", () => {
  test("removes an existing file and does not throw when it is already gone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coforge-scheduled-task-"));
    try {
      const path = join(directory, "task.xml");
      await writeFile(path, "<Task/>");
      await removeFileQuietly(path);
      await expect(readFile(path)).rejects.toThrow();
      await removeFileQuietly(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("runSchtasks", () => {
  test("reports the child's exit code and nothing else", async () => {
    expect(await runSchtasks([process.execPath, "-e", "process.exit(3)"])).toBe(3);
    expect(await runSchtasks([process.execPath, "-e", ""])).toBe(0);
  });
});
