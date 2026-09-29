import { expect, test } from "bun:test";
import {
  createFakeOpenVikingProvisioner,
  createInMemoryOpenVikingBindingStore,
} from "../openviking/stores";
import { createWorkspaceMemoryProfiles } from "./profiles";
import { createWorkspaceMemoryProfileReconciler } from "./reconciler";
import {
  createInMemoryMappedIdentityWriter,
  createInMemoryWorkspaceIdentityDirectory,
  createProductionMemoryRuntimeProvisioner,
  createPrototypeMemoryRuntimeReadiness,
} from "./runtime-provisioner";
import { createInMemoryWorkspaceMemoryProfileStore } from "./stores";

const now = new Date("2026-09-21T12:00:00.000Z");
const enabled = { prototypeEnabled: true };

test("production reconciler provisions the OV account, mapped identities, and namespace readiness", async () => {
  const store = createInMemoryWorkspaceMemoryProfileStore();
  const bindings = createInMemoryOpenVikingBindingStore();
  const identities = createInMemoryWorkspaceIdentityDirectory([
    { kind: "owner", userId: "user-ada" },
    { kind: "agent", agentId: "agent-codex" },
  ]);
  const mapped = createInMemoryMappedIdentityWriter();
  const readinessCalls: string[] = [];
  const provisioner = createProductionMemoryRuntimeProvisioner({
    openviking: createFakeOpenVikingProvisioner(),
    bindings,
    identities,
    mappedIdentities: mapped,
    readiness: {
      async ensureNamespace(input) {
        readinessCalls.push(`${input.kind}:${input.workspaceId}`);
      },
      async inspect() {
        return "healthy";
      },
    },
  });
  const profiles = createWorkspaceMemoryProfiles({ store, gate: enabled });
  const reconciler = createWorkspaceMemoryProfileReconciler({ store, provisioner });

  const selected = await profiles.selectDesired({
    workspaceId: "ws-a",
    desired: "openviking",
    at: now,
  });
  expect(selected.ok).toBe(true);
  const ready = await reconciler.reconcile("ws-a");
  expect(ready.ok).toBe(true);
  if (!ready.ok) throw new Error("reconcile failed");
  expect(ready.profile).toMatchObject({
    desired: "openviking",
    observed: "ready",
    generation: 1,
  });
  expect(ready.effects.ensured).toEqual(["openviking"]);
  expect(await bindings.get("ws-a")).toMatchObject({
    accountId: "acct-ws-a",
    serviceIdentityId: "svc-projection-ws-a",
    credentialRef: "secret:ov-ws-a",
    generation: 1,
  });
  expect(mapped.snapshot("ws-a").map((row) => row.actorKind)).toEqual([
    "owner",
    "agent",
    "projection_worker",
  ]);
  expect(readinessCalls).toEqual(["openviking:ws-a"]);
});

test("namespace unreadiness becomes a retryable provisioning error and does not mark ready", async () => {
  const store = createInMemoryWorkspaceMemoryProfileStore();
  const provisioner = createProductionMemoryRuntimeProvisioner({
    openviking: createFakeOpenVikingProvisioner(),
    bindings: createInMemoryOpenVikingBindingStore(),
    identities: createInMemoryWorkspaceIdentityDirectory(),
    readiness: {
      async ensureNamespace() {
        throw new Error("namespace missing");
      },
      async inspect() {
        return "healthy";
      },
    },
  });
  const profiles = createWorkspaceMemoryProfiles({ store, gate: enabled });
  const reconciler = createWorkspaceMemoryProfileReconciler({ store, provisioner });
  await profiles.selectDesired({ workspaceId: "ws-a", desired: "openviking", at: now });
  const failed = await reconciler.reconcile("ws-a");
  expect(failed.ok).toBe(true);
  if (!failed.ok) throw new Error("expected sanitized error profile");
  expect(failed.profile.observed).toBe("error");
  expect(failed.profile.sanitizedFailure?.code).toBe("provisioning_failed");
});

test("inspectHealth degrades a ready profile without changing generation or deleting the binding", async () => {
  const store = createInMemoryWorkspaceMemoryProfileStore();
  const bindings = createInMemoryOpenVikingBindingStore();
  let health: "healthy" | "degraded" = "healthy";
  const provisioner = createProductionMemoryRuntimeProvisioner({
    openviking: createFakeOpenVikingProvisioner(),
    bindings,
    identities: createInMemoryWorkspaceIdentityDirectory(),
    readiness: {
      ...createPrototypeMemoryRuntimeReadiness(),
      async inspect() {
        return health;
      },
    },
  });
  const profiles = createWorkspaceMemoryProfiles({ store, gate: enabled });
  const reconciler = createWorkspaceMemoryProfileReconciler({ store, provisioner });
  await profiles.selectDesired({ workspaceId: "ws-a", desired: "openviking", at: now });
  const ready = await reconciler.reconcile("ws-a");
  expect(ready.ok && ready.profile.observed === "ready").toBe(true);
  health = "degraded";
  const degraded = await reconciler.reconcile("ws-a");
  expect(degraded.ok).toBe(true);
  if (!degraded.ok) throw new Error("degrade failed");
  expect(degraded.profile).toMatchObject({ observed: "degraded", generation: 1 });
  expect(await bindings.get("ws-a")).toMatchObject({ accountId: "acct-ws-a" });
});
