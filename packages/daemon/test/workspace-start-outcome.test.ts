import { expect, test } from "bun:test";
import { WorkspaceParkedError } from "#src/supervisor/workspace-health-journal";
import {
  awaitCloudConnections,
  type WorkspaceStartPorts,
} from "#src/supervisor/workspace-start-outcome";

/** A controlled clock: each sleep advances it, so a deadline passes without real waiting. */
function ports(
  answers: Record<string, Array<{ state: string; error?: string } | null>>,
  parked: Record<string, "workspace_deleted"> = {},
): WorkspaceStartPorts & { clock: { now: number } } {
  const clock = { now: 0 };
  return {
    clock,
    parkReason: async (workspaceId) => parked[workspaceId],
    cloudConnection: async (workspaceId) => {
      const queue = answers[workspaceId] ?? [null];
      return (queue.length > 1 ? queue.shift() : queue[0]) as never;
    },
    now: () => clock.now,
    sleep: async (milliseconds) => {
      clock.now += milliseconds;
    },
  };
}

test("waits for each started Workspace's first cloud connect and reports where it stands", async () => {
  const subject = ports({
    a: [{ state: "connecting" }, { state: "connected" }],
    b: [{ state: "not_connected", error: "transport closed (2)" }],
  });

  expect(await awaitCloudConnections(subject, ["a", "b"], 1_000)).toEqual([
    { workspaceId: "a", cloudConnection: "connected" },
    { workspaceId: "b", cloudConnection: "not_connected", error: "transport closed (2)" },
  ]);
});

test("once the command's one deadline passes, every later Workspace is still checked once", async () => {
  const subject = ports({
    slow: [{ state: "connecting" }],
    ready: [{ state: "connected" }],
  });

  expect(await awaitCloudConnections(subject, ["slow", "ready"], 200)).toEqual([
    { workspaceId: "slow", cloudConnection: "connecting" },
    { workspaceId: "ready", cloudConnection: "connected" },
  ]);
  expect(subject.clock.now).toBeLessThan(300);
});

test("a Workspace still connecting at the deadline carries its latest connect failure", async () => {
  const subject = ports({
    slow: [{ state: "connecting", error: "connect error 100: internal server error" }],
  });

  expect(await awaitCloudConnections(subject, ["slow"], 200)).toEqual([
    {
      workspaceId: "slow",
      cloudConnection: "connecting",
      error: "connect error 100: internal server error",
    },
  ]);
});

test("a Workspace that parks during the wait refuses the command, after the others were checked", async () => {
  const subject = ports({ live: [{ state: "connected" }] }, { gone: "workspace_deleted" });

  const refusal = await awaitCloudConnections(subject, ["gone", "live"], 1_000).catch(
    (error: unknown) => error,
  );

  expect(refusal).toBeInstanceOf(WorkspaceParkedError);
  expect(refusal).toMatchObject({ workspaceId: "gone", code: "workspace_deleted" });
});

test("Workspaces are watched side by side, so a slow one does not hold back the others' checks", async () => {
  const asked: string[] = [];
  const subject = ports({ slow: [{ state: "connecting" }], fast: [{ state: "connecting" }] });
  const cloudConnection = subject.cloudConnection;
  subject.cloudConnection = async (workspaceId) => {
    asked.push(workspaceId);
    return cloudConnection(workspaceId);
  };

  await awaitCloudConnections(subject, ["slow", "fast"], 100);

  expect(asked.slice(0, 2)).toEqual(["slow", "fast"]);
});
