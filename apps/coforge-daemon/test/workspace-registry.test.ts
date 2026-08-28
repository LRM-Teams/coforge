import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceRegistry } from "../src/persistence/workspace-registry";
import type { WorkspaceConnection } from "../src/workspace-worker/supervisor";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("workspace registry round-trips, replaces, and deletes connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-registry-"));
  directories.push(directory);
  const registry = new WorkspaceRegistry(directory);
  const connection: WorkspaceConnection = {
    computerId: "computer-a",
    workspaceId: "workspace-a",
    workspaceRoot: "/workspaces/a",
  };

  await registry.upsert(connection);
  const replacement = { ...connection, workspaceRoot: "/workspaces/replacement" };
  await registry.upsert(replacement);
  expect(await registry.list()).toEqual([replacement]);
  expect(await Bun.file(join(directory, "config.json")).text()).not.toContain("token");

  await registry.upsert({
    ...connection,
    computerId: "computer-b",
    workspaceId: "workspace-b",
  });
  await registry.delete("workspace-a", "computer-a");
  expect(await registry.list()).toEqual([
    { ...connection, computerId: "computer-b", workspaceId: "workspace-b" },
  ]);
});
