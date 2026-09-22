import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listAgentWorkspaceFiles,
  readAgentWorkspaceFile,
} from "../src/agent-runtime/agent-workspace-files";

// macOS tmpdir lives under /var, a symlink; the path-safety checks reject linked ancestors.
const tempRoot = realpathSync(tmpdir());

test("Workspace Files listing sorts directories before files and hides dotfiles unless asked", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-files-list-"));
  try {
    await Bun.write(join(root, "b.txt"), "b");
    await Bun.write(join(root, "a.txt"), "a");
    await mkdir(join(root, "zdir"));
    await mkdir(join(root, "adir"));
    await Bun.write(join(root, ".hidden"), "secret");

    const visible = await listAgentWorkspaceFiles({
      agentWorkspaceDirectory: root,
      dirPath: "",
      includeHidden: false,
    });
    expect(visible.status).toBe("ok");
    expect(visible.rootPath).toBe(root);
    expect(visible.entries.map((entry) => entry.name)).toEqual(["adir", "zdir", "a.txt", "b.txt"]);
    expect(visible.entries.find((entry) => entry.name === "adir")?.type).toBe("dir");
    expect(visible.entries.find((entry) => entry.name === "a.txt")?.type).toBe("file");

    const withHidden = await listAgentWorkspaceFiles({
      agentWorkspaceDirectory: root,
      dirPath: "",
      includeHidden: true,
    });
    expect(withHidden.entries.map((entry) => entry.name)).toContain(".hidden");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Workspace Files listing never surfaces the runtime's reserved storage directories", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-files-builtin-"));
  try {
    await mkdir(join(root, ".builtin-runtime"));
    await mkdir(join(root, ".builtin-sessions"));
    await Bun.write(join(root, "notes.md"), "hello");

    const hidden = await listAgentWorkspaceFiles({
      agentWorkspaceDirectory: root,
      dirPath: "",
      includeHidden: true,
    });
    expect(hidden.entries.map((entry) => entry.name)).toEqual(["notes.md"]);

    const intoBuiltin = await listAgentWorkspaceFiles({
      agentWorkspaceDirectory: root,
      dirPath: ".builtin-runtime",
      includeHidden: true,
    });
    expect(intoBuiltin.status).toBe("unreadable");

    const readBuiltin = await readAgentWorkspaceFile({
      agentWorkspaceDirectory: root,
      path: ".builtin-sessions/anything.jsonl",
    });
    expect(readBuiltin.status).toBe("unreadable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Workspace Files listing reports a missing directory without leaking the filesystem error", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-files-missing-"));
  try {
    const result = await listAgentWorkspaceFiles({
      agentWorkspaceDirectory: root,
      dirPath: "does/not/exist",
      includeHidden: false,
    });
    expect(result.status).toBe("missing");
    expect(result.entries).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Workspace Files listing and reading refuse a symlink that escapes the Agent workspace", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-files-escape-"));
  try {
    const cwd = join(root, "agent"),
      outside = join(root, "outside");
    await mkdir(cwd, { recursive: true });
    await mkdir(outside, { recursive: true });
    await Bun.write(join(outside, "secret.txt"), "top secret contents");
    await symlink(outside, join(cwd, "escape-dir"));
    await symlink(join(outside, "secret.txt"), join(cwd, "escape-file.txt"));

    const listEscape = await listAgentWorkspaceFiles({
      agentWorkspaceDirectory: cwd,
      dirPath: "escape-dir",
      includeHidden: false,
    });
    expect(listEscape.status).toBe("unreadable");
    expect(JSON.stringify(listEscape)).not.toContain(outside);

    const readEscape = await readAgentWorkspaceFile({
      agentWorkspaceDirectory: cwd,
      path: "escape-file.txt",
    });
    expect(readEscape.status).toBe("unreadable");
    expect(readEscape.text).toBe("");
    expect(JSON.stringify(readEscape)).not.toContain("top secret");

    const topLevel = await listAgentWorkspaceFiles({
      agentWorkspaceDirectory: cwd,
      dirPath: "",
      includeHidden: false,
    });
    expect(topLevel.entries.find((entry) => entry.name === "escape-dir")?.type).toBe("symlink");
    expect(topLevel.entries.find((entry) => entry.name === "escape-file.txt")?.type).toBe(
      "symlink",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Workspace Files path validation rejects '..' segments and absolute paths defensively", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-files-traversal-"));
  try {
    await Bun.write(join(root, "file.txt"), "content");
    const dotdot = await listAgentWorkspaceFiles({
      agentWorkspaceDirectory: root,
      dirPath: "../outside",
      includeHidden: false,
    });
    expect(dotdot.status).toBe("unreadable");

    const absolute = await readAgentWorkspaceFile({
      agentWorkspaceDirectory: root,
      path: "/etc/passwd",
    });
    expect(absolute.status).toBe("unreadable");
    expect(absolute.text).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Workspace File read detects binary content by a NUL byte in the first 8KB", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-files-binary-"));
  try {
    const bytes = Buffer.alloc(1024, 0x41);
    bytes[512] = 0;
    await Bun.write(join(root, "blob.bin"), bytes);

    const result = await readAgentWorkspaceFile({
      agentWorkspaceDirectory: root,
      path: "blob.bin",
    });
    expect(result.status).toBe("binary");
    expect(result.text).toBe("");
    expect(result.sizeBytes).toBe(1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Workspace File read refuses a file over the 1MiB text cap", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-files-large-"));
  try {
    const content = "a".repeat(1024 * 1024 + 1);
    await Bun.write(join(root, "big.txt"), content);

    const result = await readAgentWorkspaceFile({ agentWorkspaceDirectory: root, path: "big.txt" });
    expect(result.status).toBe("too_large");
    expect(result.text).toBe("");
    expect(result.sizeBytes).toBe(1024 * 1024 + 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Workspace File read of a directory path reports unreadable, not a crash", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-files-dir-read-"));
  try {
    await mkdir(join(root, "adir"));
    const result = await readAgentWorkspaceFile({ agentWorkspaceDirectory: root, path: "adir" });
    expect(result.status).toBe("unreadable");
    expect(result.text).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Workspace File read returns the exact text content for a normal file", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-files-read-"));
  try {
    await Bun.write(join(root, "notes.txt"), "hello workspace");
    const result = await readAgentWorkspaceFile({
      agentWorkspaceDirectory: root,
      path: "notes.txt",
    });
    expect(result.status).toBe("ok");
    expect(result.text).toBe("hello workspace");
    expect(result.sizeBytes).toBe("hello workspace".length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Workspace Files error paths never leak the workspace's absolute path", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-files-privacy-"));
  try {
    const missingDir = await listAgentWorkspaceFiles({
      agentWorkspaceDirectory: root,
      dirPath: "nope",
      includeHidden: false,
    });
    const missingFile = await readAgentWorkspaceFile({
      agentWorkspaceDirectory: root,
      path: "nope.txt",
    });
    expect(JSON.stringify(missingDir)).not.toContain(root);
    expect(JSON.stringify(missingFile)).not.toContain(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Workspace File read carries a previewable image back as its media type and bytes", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-files-image-"));
  try {
    // A real 1x1 PNG, so the bytes are carried verbatim rather than re-encoded on the way out.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    );
    await Bun.write(join(root, "shot.png"), png);

    const result = await readAgentWorkspaceFile({
      agentWorkspaceDirectory: root,
      path: "shot.png",
    });
    expect(result.status).toBe("ok");
    expect(result.contentType).toBe("image/png");
    expect(result.contentBase64).toBe(png.toString("base64"));
    expect(result.text).toBe("");
    expect(result.sizeBytes).toBe(png.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Workspace File read sniffs each previewable format, and the file name never decides", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-files-signatures-"));
  try {
    // Only the header decides, and several of these contain NUL bytes: the image rule has to
    // answer before the binary rule behind it does.
    const signatures: [string, string, string][] = [
      ["a.png", "\x89PNG\r\n\x1a\n", "image/png"],
      ["a.jpg", "\xff\xd8\xff\xe0", "image/jpeg"],
      ["a.gif", "GIF87a", "image/gif"],
      ["a.webp", "RIFF\x00\x00\x00\x00WEBP", "image/webp"],
      ["a.ico", "\x00\x00\x01\x00", "image/x-icon"],
      ["a.tif", "MM\x00*", "image/tiff"],
      ["a.avif", "\x00\x00\x00\x18ftypavif", "image/avif"],
    ];
    for (const [name, header, contentType] of signatures) {
      const bytes = Buffer.concat([Buffer.from(header, "latin1"), Buffer.alloc(16, 0x41)]);
      await Bun.write(join(root, name), bytes);
      const result = await readAgentWorkspaceFile({ agentWorkspaceDirectory: root, path: name });
      expect([name, result.status, result.contentType]).toEqual([name, "ok", contentType]);
      expect(result.contentBase64).toBe(bytes.toString("base64"));
    }

    // A RIFF header alone is not a picture: the subtype has to say WebP.
    await Bun.write(join(root, "a.wav"), Buffer.from("RIFF\x00\x00\x00\x00WAVE", "latin1"));
    const wave = await readAgentWorkspaceFile({ agentWorkspaceDirectory: root, path: "a.wav" });
    expect(wave.contentType).toBe("");

    // The name is the writer's claim, not evidence: a PNG called `notes.txt` is still a PNG...
    await Bun.write(join(root, "notes.txt"), Buffer.from("\x89PNG\r\n\x1a\n", "latin1"));
    const disguised = await readAgentWorkspaceFile({
      agentWorkspaceDirectory: root,
      path: "notes.txt",
    });
    expect(disguised.contentType).toBe("image/png");

    // ...and the reverse: prose named `.png` stays text, because nothing in its bytes says image.
    await Bun.write(join(root, "diagram.png"), "this is prose, not a picture");
    const prose = await readAgentWorkspaceFile({
      agentWorkspaceDirectory: root,
      path: "diagram.png",
    });
    expect(prose.status).toBe("ok");
    expect(prose.contentType).toBe("");
    expect(prose.text).toBe("this is prose, not a picture");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Workspace File read refuses an image past the publish ceiling", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-files-image-large-"));
  try {
    const bytes = Buffer.concat([
      Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
      Buffer.alloc(1024 * 1024 + 1, 0x41),
    ]);
    await Bun.write(join(root, "huge.png"), bytes);

    const result = await readAgentWorkspaceFile({
      agentWorkspaceDirectory: root,
      path: "huge.png",
    });
    expect(result.status).toBe("too_large");
    expect(result.contentType).toBe("");
    expect(result.contentBase64).toBe("");
    expect(result.sizeBytes).toBe(bytes.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
