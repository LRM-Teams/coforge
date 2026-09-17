import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachmentMimeType,
  validateAttachmentMimeType,
  validateAttachmentUploadArgs,
} from "../src/attachment-upload";
import { CliError } from "../src/cli-error";

test("an explicit mime type always wins over the file extension", () => {
  expect(attachmentMimeType("photo.png", "application/octet-stream")).toBe(
    "application/octet-stream",
  );
});

test("infers a mime type from every documented extension", () => {
  const cases: Array<[string, string]> = [
    ["a.jpg", "image/jpeg"],
    ["a.jpeg", "image/jpeg"],
    ["a.png", "image/png"],
    ["a.gif", "image/gif"],
    ["a.webp", "image/webp"],
    ["a.pdf", "application/pdf"],
    ["a.txt", "text/plain"],
    ["a.md", "text/markdown"],
    ["a.json", "application/json"],
    ["a.csv", "text/csv"],
    ["a.PNG", "image/png"],
  ];
  for (const [path, expected] of cases) expect(attachmentMimeType(path)).toBe(expected);
});

test("falls back to application/octet-stream for an unknown or missing extension", () => {
  expect(attachmentMimeType("a.bin")).toBe("application/octet-stream");
  expect(attachmentMimeType("no-extension")).toBe("application/octet-stream");
});

test("accepts well-formed type/subtype mime strings and rejects malformed ones", () => {
  expect(() => validateAttachmentMimeType("image/png")).not.toThrow();
  expect(() => validateAttachmentMimeType("APPLICATION/JSON")).not.toThrow();
  for (const invalid of ["not-a-mime-type", "/png", "image/", "image"]) {
    expect(() => validateAttachmentMimeType(invalid)).toThrow(CliError);
    try {
      validateAttachmentMimeType(invalid);
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("INVALID_ARG");
    }
  }
});

test("rejects a missing --path or --target before any file system access", async () => {
  await expect(validateAttachmentUploadArgs({ target: "@ada" })).rejects.toMatchObject({
    code: "INVALID_ARG",
    message: "--path is required",
  });
  await expect(validateAttachmentUploadArgs({ path: "/tmp/x" })).rejects.toMatchObject({
    code: "INVALID_ARG",
    message: "--target is required",
  });
});

test("rejects a --path that does not exist", async () => {
  await expect(
    validateAttachmentUploadArgs({ path: "/tmp/coforge-missing-file.bin", target: "@ada" }),
  ).rejects.toMatchObject({
    code: "INVALID_ARG",
    message: "--path does not exist: /tmp/coforge-missing-file.bin",
  });
});

test("rejects a --path that is a directory, not a regular file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coforge-attachment-"));
  try {
    await expect(validateAttachmentUploadArgs({ path: dir, target: "@ada" })).rejects.toMatchObject(
      { code: "INVALID_ARG", message: `--path is not a regular file: ${dir}` },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects an empty file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coforge-attachment-"));
  try {
    const path = join(dir, "empty.txt");
    await writeFile(path, "");
    await expect(validateAttachmentUploadArgs({ path, target: "@ada" })).rejects.toMatchObject({
      code: "INVALID_ARG",
      message: "--path is empty; refusing to upload a 0-byte attachment",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects an invalid --mime-type before touching the file system", async () => {
  await expect(
    validateAttachmentUploadArgs({
      path: "/tmp/coforge-missing-file.bin",
      target: "@ada",
      mimeType: "bad",
    }),
  ).rejects.toMatchObject({ code: "INVALID_ARG", message: "--mime-type is invalid: bad" });
});

test("returns the file size for a valid, non-empty regular file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coforge-attachment-"));
  try {
    const path = join(dir, "note.txt");
    await writeFile(path, "hello");
    await expect(validateAttachmentUploadArgs({ path, target: "@ada" })).resolves.toEqual({
      path,
      target: "@ada",
      sizeBytes: 5,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
