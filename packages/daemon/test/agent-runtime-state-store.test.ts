import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAgentRuntimeStateStore } from "../src/persistence/agent-runtime-state-store";

test("workspace reset deletes only Agent contents, unlinks internal links and refuses linked roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "control-store-"));
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
