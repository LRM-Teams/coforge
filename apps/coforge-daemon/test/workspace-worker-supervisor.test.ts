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

const connection = (computerId: string, workspaceId: string): WorkspaceConnection => ({
  computerId,
  workspaceId,
  workspaceRoot: `/workspaces/${workspaceId}`,
});

describe("WorkspaceWorkerSupervisor", () => {
  test("reuses a worker for repeated ensure of one connection", async () => {
    const workers = [workerSpy()];
    const supervisor = new WorkspaceWorkerSupervisor({
      create: () => workers[0]!,
    });

    const first = await supervisor.ensure(connection("computer-a", "workspace-a"));
    const second = await supervisor.ensure(connection("computer-a", "workspace-a"));

    expect(second).toBe(first);
    expect(workers[0]!.startCalls).toBe(1);
    expect(supervisor.query("workspace-a", "computer-a")).toEqual({
      computerId: "computer-a",
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

    const first = await supervisor.ensure(connection("computer-a", "workspace-a"));
    const other = await supervisor.ensure(connection("computer-b", "workspace-b"));
    await supervisor.stop("workspace-a", "computer-a");
    const restarted = await supervisor.ensure(connection("computer-a", "workspace-a"));

    expect(other).not.toBe(first);
    expect(restarted).not.toBe(first);
    expect(created[0]!.stopCalls).toBe(1);
    expect(created[2]!.startCalls).toBe(1);
    expect(supervisor.query("workspace-a", "computer-a")).toEqual({
      computerId: "computer-a",
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

    await supervisor.ensure(connection("computer-a", "workspace-a"));
    await supervisor.ensure(connection("computer-b", "workspace-b"));
    await supervisor.shutdown();

    expect(created.map((worker) => worker.stopCalls)).toEqual([1, 1]);
    expect(supervisor.query("workspace-a", "computer-a")).toBeUndefined();
    expect(supervisor.query("workspace-b", "computer-b")).toBeUndefined();
  });
});
