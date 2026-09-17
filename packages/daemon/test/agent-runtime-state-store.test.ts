import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAgentRuntimeStateStore } from "../src/persistence/agent-runtime-state-store";

// macOS tmpdir lives under /var, a symlink; the state store rejects linked ancestors.
const tempRoot = realpathSync(tmpdir());

test("workspace reset deletes only Agent contents, unlinks internal links and refuses linked roots", async () => {
  const root = await mkdtemp(join(tempRoot, "control-store-"));
  try {
    const workspace = join(root, "workspaces", "w", "agents", "a");
    const home = join(root, "home");
    await mkdir(workspace, { recursive: true });
    await mkdir(home);
    await Bun.write(join(home, "keep"), "global");
    await Bun.write(join(workspace, "delete"), "local");
    await symlink(home, join(workspace, "linked-home"));
    const store = new FileAgentRuntimeStateStore(
      join(root, "state"),
      join(root, "workspaces"),
      "w",
    );
    await store.clearWorkspace("a");
    expect(await readdir(workspace)).toEqual([]);
    expect(await Bun.file(join(home, "keep")).text()).toBe("global");
    await rm(workspace, { recursive: true });
    await symlink(home, workspace);
    await expect(store.clearWorkspace("a")).rejects.toThrow("symbolic");
    expect(await Bun.file(join(home, "keep")).text()).toBe("global");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace reset continues past an entry it cannot delete and still removes the rest", async () => {
  const root = await mkdtemp(join(tempRoot, "control-store-partial-"));
  try {
    const workspace = join(root, "workspaces", "w", "agents", "a");
    const blocked = join(workspace, "blocked-dir");
    await mkdir(blocked, { recursive: true });
    await Bun.write(join(workspace, "keep-a"), "a");
    await Bun.write(join(workspace, "keep-b"), "b");
    await Bun.write(join(blocked, "undeletable"), "stuck");
    // No write permission on `blocked`: unlinking its contents fails (EACCES/EPERM), so the
    // recursive delete of that one entry cannot complete.
    await chmod(blocked, 0o500);
    const store = new FileAgentRuntimeStateStore(
      join(root, "state"),
      join(root, "workspaces"),
      "w",
    );
    try {
      await expect(store.clearWorkspace("a")).rejects.toThrow();
      // The failing entry did not stop the other entries from being removed.
      expect(await readdir(workspace)).toEqual(["blocked-dir"]);
      expect(await readdir(blocked)).toEqual(["undeletable"]);
    } finally {
      // Restore permissions so the outer `finally` can clean up the temp root.
      await chmod(blocked, 0o700);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
