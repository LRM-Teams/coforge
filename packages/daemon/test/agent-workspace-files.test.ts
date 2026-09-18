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

test("Workspace File read refuses a file over the 512KiB text cap", async () => {
  const root = await mkdtemp(join(tempRoot, "workspace-files-large-"));
  try {
    const content = "a".repeat(512 * 1024 + 1);
    await Bun.write(join(root, "big.txt"), content);

    const result = await readAgentWorkspaceFile({ agentWorkspaceDirectory: root, path: "big.txt" });
    expect(result.status).toBe("too_large");
    expect(result.text).toBe("");
    expect(result.sizeBytes).toBe(512 * 1024 + 1);
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
