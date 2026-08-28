import { expect, test } from "bun:test";
import { recoverWorkspaceConnections } from "../src/recovery";
import type { WorkspaceConnection } from "../src/workspace-worker/supervisor";

const connection = (connectionId: string): WorkspaceConnection => ({
  connectionId,
  workspaceId: `workspace-${connectionId}`,
  workspaceRoot: `/workspaces/${connectionId}`,
});

test("recovers every connection and reports failures without secrets", async () => {
  const connections = [
    connection("connection-a"),
    connection("connection-b"),
    connection("connection-c"),
  ];
  const configured: string[] = [];
  const reports: string[] = [];

  await recoverWorkspaceConnections(
    { list: async () => connections, upsert: async () => {}, delete: async () => {} },
    {
      configureWorkspaceWorker: async (entry) => {
        configured.push(entry.connectionId);
        if (entry.connectionId === "connection-b") throw new Error("secret-token");
      },
    },
    (line) => reports.push(line),
  );

  expect(configured).toEqual(["connection-a", "connection-b", "connection-c"]);
  expect(reports).toEqual(["coforge-daemon: failed to recover workspace connection connection-b"]);
  expect(reports.join("\n")).not.toContain("secret-token");
});
