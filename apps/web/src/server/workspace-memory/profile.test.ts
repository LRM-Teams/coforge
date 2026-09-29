import { expect, test } from "bun:test";
import {
  applyWorkspaceMemoryCommand,
  createDefaultWorkspaceMemoryProfile,
  parseDesiredWorkspaceMemoryProfile,
  parseObservedWorkspaceMemoryState,
  type WorkspaceMemoryProfile,
} from "./profile";
import { createInMemoryWorkspaceMemoryProfileStore, saveProfileTransition } from "./stores";
import { isOpenVikingPrototypeEnabled, OPENVIKING_PROTOTYPE_FLAG } from "./prototype-gate";
import { sanitizeWorkspaceMemoryFailure } from "./errors";

const now = new Date("2026-09-21T12:00:00.000Z");
const later = new Date("2026-09-21T13:00:00.000Z");
const enabled = { prototypeEnabled: true };
const disabled = { prototypeEnabled: false };

function seed(workspaceId = "ws-a"): WorkspaceMemoryProfile {
  return createDefaultWorkspaceMemoryProfile(workspaceId);
}

function unwrap(result: ReturnType<typeof applyWorkspaceMemoryCommand>): WorkspaceMemoryProfile {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failure.code);
  return result.profile;
}

test("a Workspace defaults to desired off, observed ready, generation 0, and no activation cursor", () => {
  const profile = seed();
  expect(profile.desired).toBe("off");
  expect(profile.observed).toBe("ready");
  expect(profile.generation).toBe(0);
  expect(profile.activationCursor).toBeNull();
  expect(profile.sanitizedFailure).toBeNull();
});

test("OpenViking stays off unless the prototype flag is an explicit opt-in", () => {
  expect(OPENVIKING_PROTOTYPE_FLAG).toBe("OPENVIKING_PROTOTYPE_ENABLED");
  expect(isOpenVikingPrototypeEnabled({})).toBe(false);
  expect(isOpenVikingPrototypeEnabled({ OPENVIKING_PROTOTYPE_ENABLED: "" })).toBe(false);
  expect(isOpenVikingPrototypeEnabled({ OPENVIKING_PROTOTYPE_ENABLED: "false" })).toBe(false);
  expect(isOpenVikingPrototypeEnabled({ OPENVIKING_PROTOTYPE_ENABLED: "TRUE" })).toBe(false);
  expect(isOpenVikingPrototypeEnabled({ OPENVIKING_PROTOTYPE_ENABLED: "yes" })).toBe(false);
  expect(isOpenVikingPrototypeEnabled({ OPENVIKING_PROTOTYPE_ENABLED: "true" })).toBe(true);
  expect(isOpenVikingPrototypeEnabled({ OPENVIKING_PROTOTYPE_ENABLED: "1" })).toBe(true);
});

test("selecting openviking without prototype opt-in fails closed and stays off", () => {
  {
    const result = applyWorkspaceMemoryCommand(
      seed(),
      { type: "select_desired", desired: "openviking", at: now },
      disabled,
    );
    expect(result).toEqual({
      ok: false,
      failure: { code: "prototype_disabled", message: "OpenViking prototype is not enabled" },
    });
  }
  expect(
    applyWorkspaceMemoryCommand(
      seed(),
      { type: "select_desired", desired: "off", at: now },
      disabled,
    ),
  ).toEqual({
    ok: true,
    profile: seed(),
  });
});

test("off provisions openviking and reverse switches retain the activation cursor", () => {
  const openviking = unwrap(
    applyWorkspaceMemoryCommand(
      seed(),
      { type: "select_desired", desired: "openviking", at: now },
      enabled,
    ),
  );
  expect(openviking).toMatchObject({
    desired: "openviking",
    observed: "provisioning",
    generation: 1,
    reconcileKind: "provision",
    activationCursor: { kind: "time", occurredAt: now.toISOString() },
    sanitizedFailure: null,
  });

  const ovReady = unwrap(
    applyWorkspaceMemoryCommand(openviking, { type: "observe_ready", generation: 1 }),
  );
  expect(ovReady.observed).toBe("ready");
  expect(ovReady.reconcileKind).toBeNull();

  const toOff = unwrap(
    applyWorkspaceMemoryCommand(
      ovReady,
      { type: "select_desired", desired: "off", at: later },
      enabled,
    ),
  );
  expect(toOff).toMatchObject({
    desired: "off",
    observed: "switching",
    generation: 2,
    reconcileKind: "switch",
    activationCursor: { kind: "time", occurredAt: now.toISOString() },
  });
  const offReady = unwrap(
    applyWorkspaceMemoryCommand(toOff, { type: "observe_ready", generation: 2 }),
  );
  expect(offReady.observed).toBe("ready");

  const backToOv = unwrap(
    applyWorkspaceMemoryCommand(
      offReady,
      {
        type: "select_desired",
        desired: "openviking",
        at: new Date("2026-09-21T14:00:00.000Z"),
        afterMessageId: "msg-100",
      },
      enabled,
    ),
  );
  expect(backToOv).toMatchObject({
    desired: "openviking",
    observed: "provisioning",
    generation: 3,
    reconcileKind: "provision",
    activationCursor: {
      kind: "message",
      occurredAt: "2026-09-21T14:00:00.000Z",
      messageId: "msg-100",
    },
  });

  const off = unwrap(
    applyWorkspaceMemoryCommand(
      unwrap(applyWorkspaceMemoryCommand(backToOv, { type: "observe_ready", generation: 3 })),
      { type: "select_desired", desired: "off", at: new Date("2026-09-21T15:00:00.000Z") },
      enabled,
    ),
  );
  expect(off).toMatchObject({
    desired: "off",
    observed: "switching",
    generation: 4,
    reconcileKind: "switch",
  });
  expect(off.activationCursor).not.toBeNull();
});

test("off can provision openviking directly when the prototype is opted in", () => {
  const profile = unwrap(
    applyWorkspaceMemoryCommand(
      seed(),
      { type: "select_desired", desired: "openviking", at: now },
      enabled,
    ),
  );
  expect(profile).toMatchObject({
    desired: "openviking",
    observed: "provisioning",
    generation: 1,
    reconcileKind: "provision",
  });
});

test("ready degrades and recovers without changing generation or the activation cursor", () => {
  const ready = unwrap(
    applyWorkspaceMemoryCommand(
      unwrap(
        applyWorkspaceMemoryCommand(
          seed(),
          { type: "select_desired", desired: "openviking", at: now },
          enabled,
        ),
      ),
      { type: "observe_ready", generation: 1 },
    ),
  );
  const degraded = unwrap(
    applyWorkspaceMemoryCommand(ready, { type: "observe_degraded", generation: 1 }),
  );
  expect(degraded).toMatchObject({
    desired: "openviking",
    observed: "degraded",
    generation: 1,
    activationCursor: ready.activationCursor,
  });
  const recovered = unwrap(
    applyWorkspaceMemoryCommand(degraded, { type: "observe_ready", generation: 1 }),
  );
  expect(recovered.observed).toBe("ready");
  expect(recovered.generation).toBe(1);
});

test("a provisioning error retries at the same generation and can then become ready", () => {
  const provisioning = unwrap(
    applyWorkspaceMemoryCommand(
      seed(),
      { type: "select_desired", desired: "openviking", at: now },
      enabled,
    ),
  );
  const failed = unwrap(
    applyWorkspaceMemoryCommand(provisioning, {
      type: "observe_error",
      generation: 1,
      failure: sanitizeWorkspaceMemoryFailure("provisioning_failed"),
    }),
  );
  expect(failed).toMatchObject({
    observed: "error",
    generation: 1,
    reconcileKind: "provision",
    sanitizedFailure: {
      code: "provisioning_failed",
      message: "memory runtime provisioning failed",
    },
  });

  const retried = unwrap(applyWorkspaceMemoryCommand(failed, { type: "retry", generation: 1 }));
  expect(retried).toMatchObject({
    observed: "provisioning",
    generation: 1,
    sanitizedFailure: null,
  });
  expect(
    unwrap(applyWorkspaceMemoryCommand(retried, { type: "observe_ready", generation: 1 })).observed,
  ).toBe("ready");
});

test("a failed switch retries as switching, not as a first-time provision", () => {
  const ready = unwrap(
    applyWorkspaceMemoryCommand(
      unwrap(
        applyWorkspaceMemoryCommand(
          seed(),
          { type: "select_desired", desired: "openviking", at: now },
          enabled,
        ),
      ),
      { type: "observe_ready", generation: 1 },
    ),
  );
  const switching = unwrap(
    applyWorkspaceMemoryCommand(
      ready,
      { type: "select_desired", desired: "off", at: later },
      enabled,
    ),
  );
  const failed = unwrap(
    applyWorkspaceMemoryCommand(switching, {
      type: "observe_error",
      generation: 2,
      failure: sanitizeWorkspaceMemoryFailure("provisioning_failed"),
    }),
  );
  const retried = unwrap(applyWorkspaceMemoryCommand(failed, { type: "retry", generation: 2 }));
  expect(retried).toMatchObject({
    desired: "off",
    observed: "switching",
    generation: 2,
    reconcileKind: "switch",
  });
});

test("an old generation cannot apply observed updates or overwrite a newer profile", async () => {
  const selected = unwrap(
    applyWorkspaceMemoryCommand(
      seed(),
      { type: "select_desired", desired: "openviking", at: now },
      enabled,
    ),
  );
  expect(applyWorkspaceMemoryCommand(selected, { type: "observe_ready", generation: 0 })).toEqual({
    ok: false,
    failure: { code: "stale_generation", message: "profile generation is stale" },
  });

  const store = createInMemoryWorkspaceMemoryProfileStore();
  expect(await saveProfileTransition(store, seed(), selected)).toBe("saved");
  const newer = unwrap(
    applyWorkspaceMemoryCommand(
      unwrap(applyWorkspaceMemoryCommand(selected, { type: "observe_ready", generation: 1 })),
      { type: "select_desired", desired: "off", at: later },
      enabled,
    ),
  );
  expect(await saveProfileTransition(store, selected, newer)).toBe("saved");
  const staleOverwrite = await saveProfileTransition(store, selected, {
    ...selected,
    observed: "ready",
  });
  expect(staleOverwrite).toBe("stale_generation");
  expect(await store.get("ws-a")).toMatchObject({ desired: "off", generation: 2 });
});

test("selecting the current desired profile while ready is a no-op", () => {
  const ready = unwrap(
    applyWorkspaceMemoryCommand(
      unwrap(
        applyWorkspaceMemoryCommand(
          seed(),
          { type: "select_desired", desired: "openviking", at: now },
          enabled,
        ),
      ),
      { type: "observe_ready", generation: 1 },
    ),
  );
  expect(
    applyWorkspaceMemoryCommand(
      ready,
      { type: "select_desired", desired: "openviking", at: later },
      enabled,
    ),
  ).toEqual({ ok: true, profile: ready });
});

test("unknown desired or observed values fail closed", () => {
  expect(parseDesiredWorkspaceMemoryProfile("off")).toBe("off");
  expect(parseDesiredWorkspaceMemoryProfile("openviking")).toBe("openviking");
  expect(parseDesiredWorkspaceMemoryProfile("causal_openviking")).toBeNull();
  expect(parseDesiredWorkspaceMemoryProfile("every_agent")).toBeNull();
  expect(parseDesiredWorkspaceMemoryProfile("on")).toBeNull();
  expect(parseObservedWorkspaceMemoryState("ready")).toBe("ready");
  expect(parseObservedWorkspaceMemoryState("healthy")).toBeNull();
});

test("sanitized failures never echo secrets, paths, or raw diagnostics", () => {
  const failure = sanitizeWorkspaceMemoryFailure(
    "provisioning_failed",
    "Bearer ov-secret at /var/lib/openviking/account.db",
  );
  expect(failure.message).toBe("memory runtime provisioning failed");
  expect(failure.message).not.toContain("Bearer");
  expect(failure.message).not.toContain("/var/lib");
  expect(failure.message).not.toContain("ov-secret");
});

test("workspace-memory contracts import no Prisma or transport framework", async () => {
  const sources = [
    "admission.ts",
    "errors.ts",
    "index.ts",
    "profile.ts",
    "profiles.ts",
    "prototype-gate.ts",
    "reconciler.ts",
    "stores.ts",
  ];
  for (const name of sources) {
    const text = await Bun.file(`${import.meta.dir}/${name}`).text();
    expect(text).not.toMatch(/@prisma/);
    expect(text).not.toMatch(/@tanstack/);
    expect(text).not.toMatch(/from ["']prisma/);
    expect(text).not.toMatch(/\bfetch\s*\(/);
  }
});
