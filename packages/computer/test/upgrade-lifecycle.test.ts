import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryDaemonCredentialStore,
  startDaemonLocalRpcServer,
  WorkspaceHealthJournal,
  workspaceHealthJournalPath,
  workspaceStateDirectory,
} from "@lrm/coforge-daemon";
import type { ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";
import { createSupervisorUpgradeLifecycle } from "#src/release/upgrade-lifecycle";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "coforge-upgrade-lifecycle-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const lifecycle = () =>
  createSupervisorUpgradeLifecycle({
    installRoot: join(root, "install"),
    supervisorSocketPath: join(root, "daemon.sock"),
    supervisorStatePath: root,
    homeDirectory: root,
  });

const runtime = (workspaceId: string, extra: Partial<ManagedRuntimeIdentity> = {}) => ({
  workspaceId,
  computerId: "computer",
  enabled: true,
  processId: 0,
  instanceId: "",
  version: "",
  ...extra,
});

test("a parked Workspace does not make a running Coordinator's runtime set unhealthy", async () => {
  const server = await startDaemonLocalRpcServer({
    socketPath: join(root, "daemon.sock"),
    validateCredential: () => true,
    credentials: new InMemoryDaemonCredentialStore(),
    runtime: {
      command: async () => [
        runtime("live", { processId: 4242, instanceId: "i", version: "v" }),
        runtime("gone", { parkReason: "workspace_deleted" }),
      ],
    },
  });
  try {
    const subject = lifecycle();
    await subject.pauseLaunches("request-1");

    expect(await subject.snapshot()).toMatchObject({
      supervisorRunning: true,
      bindings: [
        { bindingId: "live", running: true },
        { bindingId: "gone", running: false },
      ],
    });
  } finally {
    await server.close();
  }
});

test("an enabled Workspace that is down and not parked still blocks the upgrade", async () => {
  const server = await startDaemonLocalRpcServer({
    socketPath: join(root, "daemon.sock"),
    validateCredential: () => true,
    credentials: new InMemoryDaemonCredentialStore(),
    runtime: { command: async () => [runtime("down")] },
  });
  try {
    const subject = lifecycle();
    await subject.pauseLaunches("request-1");

    await expect(subject.snapshot()).rejects.toThrow(
      "Workspace runtime set is unhealthy: Workspace down is enabled but not running. Run 'coforge-computer start --workspace down' (or 'coforge-computer stop --workspace down' to leave it stopped), then upgrade again.",
    );
  } finally {
    await server.close();
  }
});

test("with no Coordinator running, a parked enabled binding does not count as one left running", async () => {
  await writeFile(
    join(root, "bindings.json"),
    JSON.stringify([{ workspaceId: "gone", enabled: true }]),
  );
  await new WorkspaceHealthJournal(
    workspaceHealthJournalPath(workspaceStateDirectory(root, "gone")),
  ).markParked("workspace_deleted");
  const subject = lifecycle();
  await subject.pauseLaunches("request-1");

  expect(await subject.snapshot()).toEqual({
    supervisorRunning: false,
    bindings: [{ bindingId: "gone", running: false, processId: null }],
  });
});

test("with no Coordinator running, an enabled binding that is not parked names the command that recovers it", async () => {
  await writeFile(
    join(root, "bindings.json"),
    JSON.stringify([{ workspaceId: "down", enabled: true }]),
  );
  const subject = lifecycle();
  await subject.pauseLaunches("request-1");

  await expect(subject.snapshot()).rejects.toThrow(
    "configured running bindings have no healthy supervisor. Run 'coforge-computer start' to recover them, then upgrade again.",
  );
});
