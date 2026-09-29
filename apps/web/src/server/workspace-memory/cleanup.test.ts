import { expect, test } from "bun:test";
import { CLEANUP_TARGETS } from "../db/repositories/workspace-memory-cleanup.repositories.server";
import { createWorkspaceMemoryProfiles } from "./profiles";
import {
  createFakeMemoryRuntimeProvisioner,
  createWorkspaceMemoryProfileReconciler,
} from "./reconciler";
import { createInMemoryWorkspaceMemoryProfileStore } from "./stores";
import {
  createFakeWorkspaceMemoryCleanupRemotes,
  createInMemoryWorkspaceMemoryCleanupStore,
  createWorkspaceMemoryCleanup,
} from "./cleanup.server";

const now = new Date("2026-09-21T12:00:00.000Z");
const later = new Date("2026-09-21T13:00:00.000Z");
const enabled = { prototypeEnabled: true };

function harness() {
  const store = createInMemoryWorkspaceMemoryCleanupStore();
  const remotes = createFakeWorkspaceMemoryCleanupRemotes();
  const cleanup = createWorkspaceMemoryCleanup({ store, remotes });
  return { store, remotes, cleanup };
}

test("workspace deletion enqueues every cleanup target and replay is a no-op", async () => {
  const { cleanup, store } = harness();
  const first = await cleanup.enqueueWorkspaceDeletion({
    workspaceId: "ws-a",
    operationId: "del-1",
  });
  expect(first.map((work) => [work.target, work.state])).toEqual(
    CLEANUP_TARGETS.map((target) => [target, "pending"]),
  );
  const replay = await cleanup.enqueueWorkspaceDeletion({
    workspaceId: "ws-a",
    operationId: "del-1",
  });
  expect(replay).toEqual(first);
  expect(await store.get("ws-b", "del-1", "openviking_account")).toBeNull();
});

test("run leases each target in order, then settles after a successful remote step", async () => {
  const { cleanup, remotes, store } = harness();
  await cleanup.enqueueWorkspaceDeletion({ workspaceId: "ws-a", operationId: "del-1" });
  const result = await cleanup.run({
    workspaceId: "ws-a",
    operationId: "del-1",
    owner: "worker-1",
    now,
    ttlMs: 60_000,
  });
  expect(result).toMatchObject({ status: "completed" });
  if (result.status !== "completed") throw new Error("expected completed");
  expect(result.works.map((work) => work.state)).toEqual(CLEANUP_TARGETS.map(() => "settled"));
  expect(remotes.calls).toEqual([...CLEANUP_TARGETS]);
  expect(await store.get("ws-a", "del-1", "openviking_binding")).toMatchObject({
    state: "settled",
    attemptCount: 1,
  });
});

test("a remote failure stays visible as retryable_failure, stops later targets, and can be leased again", async () => {
  const { cleanup, remotes, store } = harness();
  remotes.fail("openviking_account", "Bearer ov-secret at /var/lib/openviking/account.db");
  await cleanup.enqueueWorkspaceDeletion({ workspaceId: "ws-a", operationId: "del-1" });

  const failed = await cleanup.run({
    workspaceId: "ws-a",
    operationId: "del-1",
    owner: "worker-1",
    now,
    ttlMs: 60_000,
  });
  expect(failed).toMatchObject({
    status: "retryable_failure",
    failedTarget: "openviking_account",
  });
  if (failed.status !== "retryable_failure") throw new Error("expected retryable_failure");
  expect(failed.work).toMatchObject({
    state: "retryable_failure",
    sanitizedError: "openviking account delete failed",
    attemptCount: 1,
  });
  expect(failed.work.sanitizedError).not.toContain("Bearer");
  expect(failed.work.sanitizedError).not.toContain("/var/lib");
  expect(remotes.calls).toEqual(["openviking_account"]);
  expect(await store.get("ws-a", "del-1", "openviking_binding")).toMatchObject({
    state: "pending",
  });
  expect(
    await cleanup.lease({
      workspaceId: "ws-a",
      operationId: "del-1",
      target: "openviking_account",
      owner: "worker-2",
      now: later,
      ttlMs: 60_000,
    }),
  ).toMatchObject({ state: "leased", leaseOwner: "worker-2", attemptCount: 2 });
});

test("a completed cleanup run and a repeated settle are no-ops", async () => {
  const { cleanup, remotes, store } = harness();
  await cleanup.enqueueWorkspaceDeletion({ workspaceId: "ws-a", operationId: "del-1" });
  const first = await cleanup.run({
    workspaceId: "ws-a",
    operationId: "del-1",
    owner: "worker-1",
    now,
    ttlMs: 60_000,
  });
  expect(first.status).toBe("completed");
  remotes.fail("openviking_account");
  const replay = await cleanup.run({
    workspaceId: "ws-a",
    operationId: "del-1",
    owner: "worker-2",
    now: later,
    ttlMs: 60_000,
  });
  expect(replay).toMatchObject({ status: "completed" });
  expect(remotes.calls).toEqual([...CLEANUP_TARGETS]);
  const settled = await cleanup.settle({
    workspaceId: "ws-a",
    operationId: "del-1",
    target: "openviking_account",
    owner: "worker-9",
  });
  expect(settled).toMatchObject({ state: "settled", attemptCount: 1 });
  expect(await store.get("ws-a", "del-1", "openviking_account")).toEqual(settled);
});

test("profile switching and off retain runtimes and never enqueue cleanup work", async () => {
  const { cleanup, remotes, store } = harness();
  const profileStore = createInMemoryWorkspaceMemoryProfileStore();
  const profileApi = createWorkspaceMemoryProfiles({ store: profileStore, gate: enabled });
  const provisioner = createFakeMemoryRuntimeProvisioner();
  const profileReconciler = createWorkspaceMemoryProfileReconciler({
    store: profileStore,
    provisioner,
  });

  const selected = await profileApi.selectDesired({
    workspaceId: "ws-a",
    desired: "openviking",
    at: now,
  });
  expect(selected.ok).toBe(true);
  const ready = await profileReconciler.reconcile("ws-a");
  expect(ready.ok).toBe(true);
  const off = await profileApi.selectDesired({
    workspaceId: "ws-a",
    desired: "off",
    at: later,
  });
  expect(off.ok).toBe(true);
  const stopped = await profileReconciler.reconcile("ws-a");
  expect(stopped.ok).toBe(true);
  if (!stopped.ok) throw new Error("expected off reconcile");
  expect(stopped.effects.processing).toBe("stopped");
  expect(provisioner.deleted).toEqual([]);
  expect(provisioner.snapshot("ws-a").openviking).not.toBeNull();
  expect(remotes.calls).toEqual([]);
  expect(await store.get("ws-a", "del-1", "openviking_account")).toBeNull();

  await cleanup.enqueueWorkspaceDeletion({ workspaceId: "ws-a", operationId: "del-1" });
  expect(await store.get("ws-a", "del-1", "openviking_account")).toMatchObject({
    state: "pending",
  });
});

test("profile and lifecycle modules do not enqueue workspace deletion cleanup", async () => {
  const [reconciler, profiles, lifecycle, runtime] = await Promise.all([
    Bun.file(new URL("./reconciler.ts", import.meta.url)).text(),
    Bun.file(new URL("./profiles.ts", import.meta.url)).text(),
    Bun.file(new URL("./lifecycle.server.ts", import.meta.url)).text(),
    Bun.file(new URL("./runtime-provisioner.ts", import.meta.url)).text(),
  ]);
  for (const source of [reconciler, profiles, lifecycle, runtime]) {
    expect(source).not.toMatch(/enqueueWorkspaceDeletion|WorkspaceMemoryCleanupWork/);
    expect(source).not.toMatch(/deleteAccount|typed-account-delete/);
  }
});
