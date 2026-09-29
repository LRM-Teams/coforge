import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonConnectionRefusedError } from "#src/connection/daemon-connection-refused-error";
import { WorkspaceHealthJournal } from "#src/supervisor/workspace-health-journal";
import { WorkspaceParking } from "#src/supervisor/workspace-parking";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "coforge-workspace-parking-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function parking() {
  const journal = new WorkspaceHealthJournal(join(directory, "health.json"));
  return {
    journal,
    parking: new WorkspaceParking(
      journal,
      () => "workspace-a",
      () => undefined,
    ),
  };
}

test("a start that connects reports the Workspace connected", async () => {
  const { parking: subject } = parking();
  expect(subject.cloudConnection).toEqual({ state: "connecting" });

  await subject.start(async () => {});

  expect(subject.cloudConnection).toEqual({ state: "connected" });
});

test("a connection that keeps failing reports connecting with its latest failure, before and after it first connected", async () => {
  const journal = new WorkspaceHealthJournal(join(directory, "health.json"));
  let failure: string | undefined = "connect error 100: internal server error";
  const subject = new WorkspaceParking(
    journal,
    () => "workspace-a",
    () => failure,
  );
  const connecting = Promise.withResolvers<void>();
  const started = subject.start(() => connecting.promise);

  expect(subject.cloudConnection).toEqual({ state: "connecting", error: failure });
  failure = undefined;
  connecting.resolve();
  await started;
  expect(subject.cloudConnection).toEqual({ state: "connected" });

  // The connection dropped later and its reconnects are failing: it is not connected any more.
  failure = "transport error 2: transport closed";
  expect(subject.cloudConnection).toEqual({ state: "connecting", error: failure });
});

test("a start that fails for an ordinary reason reports it not connected, with why, and leaves the Workspace unparked", async () => {
  const { journal, parking: subject } = parking();

  await expect(
    subject.start(async () => {
      throw new Error("network unreachable");
    }),
  ).rejects.toThrow("network unreachable");

  expect(subject.cloudConnection).toEqual({
    state: "not_connected",
    error: "network unreachable",
  });
  expect(await journal.state()).toEqual({ status: "ok" });
});

test("a start the cloud refuses for good parks the Workspace, then shuts the process down once", async () => {
  const { journal, parking: subject } = parking();
  const shutdowns: string[] = [];

  await expect(
    subject.start(async () => {
      throw new DaemonConnectionRefusedError("workspace_deleted");
    }),
  ).rejects.toBeInstanceOf(DaemonConnectionRefusedError);
  // The process's shutdown exists only once the entrypoint has assembled it.
  await subject.bindShutdown(async () => {
    shutdowns.push("shutdown");
  });

  expect(subject.cloudConnection).toEqual({ state: "connecting" });
  expect(await journal.state()).toMatchObject({ status: "parked", reason: "workspace_deleted" });
  expect(shutdowns).toEqual(["shutdown"]);
});

test("a refusal while connected parks the Workspace, then shuts the process down", async () => {
  const { journal, parking: subject } = parking();
  const shutdowns: string[] = [];
  await subject.bindShutdown(async () => {
    shutdowns.push("shutdown");
  });

  await subject.park("computer_unlinked");

  expect(await journal.state()).toMatchObject({ status: "parked", reason: "computer_unlinked" });
  expect(shutdowns).toEqual(["shutdown"]);
});

test("a connect failure from the realtime client reports its own message and code", async () => {
  const { parking: subject } = parking();

  await expect(
    subject.start(async () => {
      throw { type: "connect", error: { code: 100, message: "internal server error" } };
    }),
  ).rejects.toBeDefined();

  expect(subject.cloudConnection).toEqual({
    state: "not_connected",
    error: "internal server error (100)",
  });
});
