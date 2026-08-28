import { expect, test } from "bun:test";
import { recoverWorkspaceConnections } from "../src/recovery";
import type { WorkspaceConnection } from "../src/workspace-worker/supervisor";

const connection = (computerId: string): WorkspaceConnection => ({
  computerId,
  workspaceId: `workspace-${computerId}`,
  workspaceRoot: `/workspaces/${computerId}`,
});

test("recovers every connection and reports failures without secrets", async () => {
  const connections = [
    connection("connection-a"),
    connection("computer-connection-b"),
    connection("connection-c"),
  ];
  const configured: string[] = [];
  const reports: string[] = [];

  await recoverWorkspaceConnections(
    { list: async () => connections, upsert: async () => {}, delete: async () => {} },
    {
      configureWorkspaceWorker: async (entry) => {
        configured.push(entry.computerId);
        if (entry.computerId === "computer-connection-b") throw new Error("secret-token");
      },
    },
    (line) => reports.push(line),
  );

  expect(configured).toEqual(["connection-a", "computer-connection-b", "connection-c"]);
  expect(reports).toEqual([
    "coforge-daemon: failed to recover workspace workspace-computer-connection-b",
  ]);
  expect(reports.join("\n")).not.toContain("secret-token");
});
