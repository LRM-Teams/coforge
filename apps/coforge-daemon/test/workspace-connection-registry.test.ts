import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileWorkspaceConnectionRegistry } from "../src/persistence/workspace-connection-registry";
import type { WorkspaceConnection } from "../src/workspace-worker/supervisor";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("file workspace connection registry round-trips, replaces, and deletes connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-registry-"));
  directories.push(directory);
  const registry = new FileWorkspaceConnectionRegistry(directory);
  const connection: WorkspaceConnection = {
    connectionId: "connection-a",
    workspaceId: "workspace-a",
    workspaceRoot: "/workspaces/a",
  };

  await registry.upsert(connection);
  const replacement = { ...connection, workspaceRoot: "/workspaces/replacement" };
  await registry.upsert(replacement);
  expect(await registry.list()).toEqual([replacement]);
  expect(await Bun.file(join(directory, "workspace-connections.json")).text()).not.toContain(
    "token",
  );

  await registry.upsert({
    ...connection,
    connectionId: "connection-b",
    workspaceId: "workspace-b",
  });
  await registry.delete("connection-a");
  expect(await registry.list()).toEqual([
    { ...connection, connectionId: "connection-b", workspaceId: "workspace-b" },
  ]);
});
