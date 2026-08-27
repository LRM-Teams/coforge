import { describe, expect, test } from "bun:test";
import {
  WorkspaceWorkerSupervisor,
  type WorkspaceConnection,
  type WorkspaceWorker,
} from "../src/workspace-worker/supervisor";

function workerSpy() {
  return {
    startCalls: 0,
    stopCalls: 0,
    async start() {
      this.startCalls += 1;
    },
    async stop() {
      this.stopCalls += 1;
    },
  } satisfies WorkspaceWorker & { startCalls: number; stopCalls: number };
}

const connection = (connectionId: string, workspaceId: string): WorkspaceConnection => ({
  connectionId,
  workspaceId,
  workspaceRoot: `/workspaces/${workspaceId}`,
});

describe("WorkspaceWorkerSupervisor", () => {
  test("reuses a worker for repeated ensure of one connection", async () => {
    const workers = [workerSpy()];
    const supervisor = new WorkspaceWorkerSupervisor({
      create: () => workers[0]!,
    });

    const first = await supervisor.ensure(connection("connection-a", "workspace-a"));
    const second = await supervisor.ensure(connection("connection-a", "workspace-a"));

    expect(second).toBe(first);
    expect(workers[0]!.startCalls).toBe(1);
    expect(supervisor.query("connection-a")).toEqual({
      connectionId: "connection-a",
      workspaceId: "workspace-a",
    });
  });

  test("keeps different workspaces isolated and supports stop then restart", async () => {
    const created: ReturnType<typeof workerSpy>[] = [];
    const supervisor = new WorkspaceWorkerSupervisor({
      create: () => {
        const worker = workerSpy();
        created.push(worker);
        return worker;
      },
    });

    const first = await supervisor.ensure(connection("connection-a", "workspace-a"));
    const other = await supervisor.ensure(connection("connection-b", "workspace-b"));
    await supervisor.stop("connection-a");
    const restarted = await supervisor.ensure(connection("connection-a", "workspace-a"));

    expect(other).not.toBe(first);
    expect(restarted).not.toBe(first);
    expect(created[0]!.stopCalls).toBe(1);
    expect(created[2]!.startCalls).toBe(1);
    expect(supervisor.query("connection-a")).toEqual({
      connectionId: "connection-a",
      workspaceId: "workspace-a",
    });
  });

  test("shutdown stops every worker and removes it from the running set", async () => {
    const created: ReturnType<typeof workerSpy>[] = [];
    const supervisor = new WorkspaceWorkerSupervisor({
      create: () => {
        const worker = workerSpy();
        created.push(worker);
        return worker;
      },
    });

    await supervisor.ensure(connection("connection-a", "workspace-a"));
    await supervisor.ensure(connection("connection-b", "workspace-b"));
    await supervisor.shutdown();

    expect(created.map((worker) => worker.stopCalls)).toEqual([1, 1]);
    expect(supervisor.query("connection-a")).toBeUndefined();
    expect(supervisor.query("connection-b")).toBeUndefined();
  });
});
