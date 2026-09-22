import { expect, test } from "bun:test";
import { createDefaultWorkspaceMemoryProfile } from "./profile";
import { createWorkspaceMemoryProfiles } from "./profiles";
import {
  createFakeMemoryRuntimeProvisioner,
  createWorkspaceMemoryProfileReconciler,
  reconcile,
} from "./reconciler";
import { createInMemoryWorkspaceMemoryProfileStore } from "./stores";

const now = new Date("2026-09-21T12:00:00.000Z");
const later = new Date("2026-09-21T13:00:00.000Z");
const enabled = { prototypeEnabled: true };

function harness() {
  const store = createInMemoryWorkspaceMemoryProfileStore();
  const provisioner = createFakeMemoryRuntimeProvisioner();
  const profiles = createWorkspaceMemoryProfiles({ store, gate: enabled });
  const reconciler = createWorkspaceMemoryProfileReconciler({ store, provisioner });
  return { store, provisioner, profiles, reconciler };
}

async function unwrap<T extends { ok: boolean }>(result: T): Promise<Extract<T, { ok: true }>> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected ok result");
  return result as Extract<T, { ok: true }>;
}

test("off provisions openviking, then switches to causal and back without deleting runtimes or the cursor", async () => {
  const { profiles, reconciler, provisioner } = harness();

  const selected = await unwrap(
    await profiles.selectDesired({
      workspaceId: "ws-a",
      desired: "openviking",
      at: now,
    }),
  );
  expect(selected.profile).toMatchObject({
    desired: "openviking",
    observed: "provisioning",
    generation: 1,
    reconcileKind: "provision",
    activationCursor: { kind: "time", occurredAt: now.toISOString() },
  });

  const openviking = await unwrap(await reconciler.reconcile("ws-a"));
  expect(openviking.profile).toMatchObject({
    desired: "openviking",
    observed: "ready",
    generation: 1,
    reconcileKind: null,
  });
  expect(openviking.effects.processing).toBe("active");
  expect(openviking.effects.ensured).toEqual(["openviking"]);
  expect(provisioner.snapshot("ws-a")).toMatchObject({
    openviking: { resourceId: "acct-ws-a", generation: 1 },
    causalTenant: null,
  });

  await unwrap(
    await profiles.selectDesired({
      workspaceId: "ws-a",
      desired: "causal_openviking",
      at: later,
      afterMessageId: "msg-100",
    }),
  );
  const causal = await unwrap(await reconciler.reconcile("ws-a"));
  expect(causal.profile).toMatchObject({
    desired: "causal_openviking",
    observed: "ready",
    generation: 2,
    activationCursor: { kind: "message", occurredAt: later.toISOString(), messageId: "msg-100" },
  });
  expect(causal.effects.ensured).toEqual(["openviking", "causal_tenant"]);
  expect(provisioner.snapshot("ws-a").openviking?.resourceId).toBe("acct-ws-a");
  expect(provisioner.snapshot("ws-a").causalTenant?.resourceId).toBe("tenant-ws-a");

  await unwrap(
    await profiles.selectDesired({
      workspaceId: "ws-a",
      desired: "openviking",
      at: new Date("2026-09-21T14:00:00.000Z"),
    }),
  );
  const back = await unwrap(await reconciler.reconcile("ws-a"));
  expect(back.profile).toMatchObject({
    desired: "openviking",
    observed: "ready",
    generation: 3,
  });
  expect(back.effects.processing).toBe("active");
  expect(provisioner.snapshot("ws-a")).toMatchObject({
    openviking: { resourceId: "acct-ws-a" },
    causalTenant: { resourceId: "tenant-ws-a" },
  });
  expect(back.profile.activationCursor).toEqual({
    kind: "time",
    occurredAt: "2026-09-21T14:00:00.000Z",
  });

  await unwrap(
    await profiles.selectDesired({
      workspaceId: "ws-a",
      desired: "off",
      at: new Date("2026-09-21T15:00:00.000Z"),
    }),
  );
  const off = await unwrap(await reconciler.reconcile("ws-a"));
  expect(off.profile).toMatchObject({
    desired: "off",
    observed: "ready",
    generation: 4,
    reconcileKind: null,
  });
  expect(off.effects.processing).toBe("stopped");
  expect(off.effects.ensured).toEqual([]);
  expect(off.profile.activationCursor).toEqual({
    kind: "time",
    occurredAt: "2026-09-21T14:00:00.000Z",
  });
  expect(provisioner.snapshot("ws-a")).toMatchObject({
    openviking: { resourceId: "acct-ws-a" },
    causalTenant: { resourceId: "tenant-ws-a" },
  });
  expect(provisioner.deleted).toEqual([]);
});

test("off can provision causal_openviking directly and keep both runtimes after turning off", async () => {
  const { profiles, reconciler, provisioner } = harness();
  await unwrap(
    await profiles.selectDesired({
      workspaceId: "ws-a",
      desired: "causal_openviking",
      at: now,
    }),
  );
  const ready = await unwrap(await reconciler.reconcile("ws-a"));
  expect(ready.profile).toMatchObject({
    desired: "causal_openviking",
    observed: "ready",
    generation: 1,
    reconcileKind: null,
  });
  expect(ready.effects.ensured).toEqual(["openviking", "causal_tenant"]);

  await unwrap(await profiles.selectDesired({ workspaceId: "ws-a", desired: "off", at: later }));
  const off = await unwrap(await reconciler.reconcile("ws-a"));
  expect(off.profile.observed).toBe("ready");
  expect(off.effects.processing).toBe("stopped");
  expect(provisioner.snapshot("ws-a").openviking).not.toBeNull();
  expect(provisioner.snapshot("ws-a").causalTenant).not.toBeNull();
  expect(provisioner.deleted).toEqual([]);
});

test("partial provisioning failure is retryable at the same generation and keeps the successful binding", async () => {
  const { profiles, reconciler, provisioner } = harness();
  provisioner.failNext("causal_tenant", "Bearer ov-secret at /var/lib/openviking/account.db");
  await unwrap(
    await profiles.selectDesired({
      workspaceId: "ws-a",
      desired: "causal_openviking",
      at: now,
    }),
  );

  const failed = await unwrap(await reconciler.reconcile("ws-a"));
  expect(failed.profile).toMatchObject({
    desired: "causal_openviking",
    observed: "error",
    generation: 1,
    reconcileKind: "provision",
    sanitizedFailure: {
      code: "provisioning_failed",
      message: "memory runtime provisioning failed",
    },
  });
  expect(failed.profile.sanitizedFailure?.message).not.toContain("Bearer");
  expect(failed.profile.sanitizedFailure?.message).not.toContain("/var/lib");
  expect(failed.profile.sanitizedFailure?.message).not.toContain("ov-secret");
  expect(failed.effects.ensured).toEqual(["openviking"]);
  expect(provisioner.snapshot("ws-a")).toMatchObject({
    openviking: { resourceId: "acct-ws-a" },
    causalTenant: null,
  });

  const recovered = await unwrap(await reconciler.reconcile("ws-a"));
  expect(recovered.profile).toMatchObject({
    observed: "ready",
    generation: 1,
    sanitizedFailure: null,
  });
  expect(provisioner.snapshot("ws-a").causalTenant?.resourceId).toBe("tenant-ws-a");
});

test("a failed switch retries as switching and does not delete the prior OpenViking binding", async () => {
  const { profiles, reconciler, provisioner } = harness();
  await unwrap(
    await profiles.selectDesired({ workspaceId: "ws-a", desired: "openviking", at: now }),
  );
  await unwrap(await reconciler.reconcile("ws-a"));
  provisioner.failNext("causal_tenant", "token=super-secret");
  await unwrap(
    await profiles.selectDesired({
      workspaceId: "ws-a",
      desired: "causal_openviking",
      at: later,
    }),
  );

  const failed = await unwrap(await reconciler.reconcile("ws-a"));
  expect(failed.profile).toMatchObject({
    desired: "causal_openviking",
    observed: "error",
    generation: 2,
    reconcileKind: "switch",
  });
  expect(failed.profile.sanitizedFailure?.message).not.toContain("super-secret");
  expect(provisioner.snapshot("ws-a").openviking?.resourceId).toBe("acct-ws-a");
  expect(provisioner.deleted).toEqual([]);

  const recovered = await unwrap(await reconciler.reconcile("ws-a"));
  expect(recovered.profile).toMatchObject({
    desired: "causal_openviking",
    observed: "ready",
    generation: 2,
    reconcileKind: null,
  });
});

test("ready degrades and recovers without changing generation, cursor, or bindings", async () => {
  const { profiles, reconciler, provisioner } = harness();
  await unwrap(
    await profiles.selectDesired({ workspaceId: "ws-a", desired: "openviking", at: now }),
  );
  const ready = await unwrap(await reconciler.reconcile("ws-a"));
  provisioner.setHealth("degraded");

  const degraded = await unwrap(await reconciler.reconcile("ws-a"));
  expect(degraded.profile).toMatchObject({
    desired: "openviking",
    observed: "degraded",
    generation: 1,
    activationCursor: ready.profile.activationCursor,
  });
  expect(provisioner.snapshot("ws-a").openviking?.resourceId).toBe("acct-ws-a");

  provisioner.setHealth("healthy");
  const recovered = await unwrap(await reconciler.reconcile("ws-a"));
  expect(recovered.profile.observed).toBe("ready");
  expect(recovered.profile.generation).toBe(1);
  expect(recovered.profile.activationCursor).toEqual(ready.profile.activationCursor);
  expect(provisioner.deleted).toEqual([]);
});

test("a stale generation cannot take over during reconcile or overwrite a newer desired profile", async () => {
  const { profiles, reconciler, provisioner, store } = harness();
  await unwrap(
    await profiles.selectDesired({ workspaceId: "ws-a", desired: "openviking", at: now }),
  );

  const held = provisioner.holdEnsure();
  const first = reconciler.reconcile("ws-a");
  await unwrap(
    await profiles.selectDesired({
      workspaceId: "ws-a",
      desired: "causal_openviking",
      at: later,
    }),
  );
  held.release();

  expect(await first).toEqual({
    ok: false,
    failure: { code: "stale_generation", message: "profile generation is stale" },
  });
  expect(await profiles.get("ws-a")).toMatchObject({
    desired: "causal_openviking",
    observed: "switching",
    generation: 2,
  });

  const settled = await unwrap(await reconciler.reconcile("ws-a"));
  expect(settled.profile).toMatchObject({
    desired: "causal_openviking",
    observed: "ready",
    generation: 2,
  });

  const staleState = createDefaultWorkspaceMemoryProfile("ws-a");
  staleState.desired = "openviking";
  staleState.observed = "provisioning";
  staleState.generation = 1;
  expect(await reconcile(staleState, provisioner)).toEqual({
    ok: false,
    failure: { code: "stale_generation", message: "profile generation is stale" },
  });
  expect(await store.get("ws-a")).toMatchObject({ desired: "causal_openviking", generation: 2 });
});

test("selectDesired rejects a stale expected generation and an unknown profile without writing", async () => {
  const { profiles } = harness();
  await unwrap(
    await profiles.selectDesired({ workspaceId: "ws-a", desired: "openviking", at: now }),
  );
  expect(
    await profiles.selectDesired({
      workspaceId: "ws-a",
      desired: "causal_openviking",
      at: later,
      expectedGeneration: 0,
    }),
  ).toEqual({
    ok: false,
    failure: { code: "stale_generation", message: "profile generation is stale" },
  });
  expect(await profiles.get("ws-a")).toMatchObject({
    desired: "openviking",
    observed: "provisioning",
    generation: 1,
  });
  expect(
    await profiles.selectDesired({
      workspaceId: "ws-a",
      desired: "every_agent",
      at: later,
    }),
  ).toEqual({
    ok: false,
    failure: { code: "invalid_profile", message: "workspace memory profile is invalid" },
  });
});

test("selectDesired stays fail-closed when the prototype gate is off", async () => {
  const store = createInMemoryWorkspaceMemoryProfileStore();
  const profiles = createWorkspaceMemoryProfiles({ store });
  expect(
    await profiles.selectDesired({ workspaceId: "ws-a", desired: "openviking", at: now }),
  ).toEqual({
    ok: false,
    failure: { code: "prototype_disabled", message: "OpenViking prototype is not enabled" },
  });
  expect(await profiles.get("ws-a")).toEqual(createDefaultWorkspaceMemoryProfile("ws-a"));
});

test("a missing Workspace is desired off, observed ready, and reconcile is a stopped no-op", async () => {
  const { profiles, reconciler, provisioner } = harness();
  expect(await profiles.get("ws-missing")).toEqual(
    createDefaultWorkspaceMemoryProfile("ws-missing"),
  );
  const result = await unwrap(await reconciler.reconcile("ws-missing"));
  expect(result.profile).toEqual(createDefaultWorkspaceMemoryProfile("ws-missing"));
  expect(result.effects).toEqual({ ensured: [], processing: "stopped" });
  expect(provisioner.snapshot("ws-missing")).toEqual({ openviking: null, causalTenant: null });
});

test("P1 modules stay framework-free and never import OpenViking HTTP details", async () => {
  for (const name of ["profiles.ts", "reconciler.ts"]) {
    const text = await Bun.file(`${import.meta.dir}/${name}`).text();
    expect(text).not.toMatch(/@prisma/);
    expect(text).not.toMatch(/@tanstack/);
    expect(text).not.toMatch(/from ["']prisma/);
    expect(text).not.toMatch(/\bfetch\s*\(/);
    expect(text).not.toMatch(/from ["']\.\.\/openviking/);
  }
});
