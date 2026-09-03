import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonConfigStore } from "../src/persistence/daemon-config";

test("daemon config stores one replaceable configuration without credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-config-"));
  try {
    const store = new DaemonConfigStore(directory);
    const config = { computerId: "computer-a", workspaceId: "workspace-a", workspaceRoot: "/work" };
    await store.save(config);
    expect(await store.load()).toEqual(config);
    await store.save({ ...config, workspaceRoot: "/replacement" });
    expect(await store.load()).toEqual({ ...config, workspaceRoot: "/replacement" });
    expect(await Bun.file(join(directory, "config.json")).text()).not.toContain("token");
    await store.clear();
    expect(await store.load()).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
