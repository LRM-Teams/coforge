import { expect, test } from "bun:test";
import { Prisma } from "../generated/client";
import { PrismaAgentControlStore } from "../src/server/db/repositories/agent-control.repositories.server";
import {
  agentControlRevision,
  type AgentControlState,
} from "../src/server/agents/agent-control.server";
import type { PrismaClient } from "../generated/client";

/**
 * ADR 0039 removed `updatedAtMs`/abandonment entirely, but a row persisted before that change
 * still carries the field in its stored `controlState` JSONB. `stateSchema` keeps accepting it
 * on read (legacy, ignored, never written); these tests prove the field never reaches the
 * application-level `AgentControlState`, that the next write no longer contains it, and — the
 * bug this repository fix targets — that `replace()`'s compare-and-swap does not lose against a
 * legacy row merely because it carries that extra key (Postgres JSONB `=` is structural, so a
 * predicate reconstructed from the already-stripped `AgentControlState` would never match).
 */

const runtimeConfig = {
  runtime: "pi" as const,
  provider: { kind: "default" as const },
  model: "",
  modelProvider: "",
  reasoning: "",
};

const legacyStoredState = {
  version: 1,
  protocolMajor: 1,
  requestId: "legacy",
  workspaceId: "w",
  computerId: "c",
  agentId: "a",
  provider: "pi",
  epoch: 4,
  action: "start",
  phase: "starting",
  configRevision: agentControlRevision(runtimeConfig),
  controlSequence: 0,
  sessionSequence: 0,
  // A pre-ADR-0039 row: the field this repository must accept on read, strip before handing the
  // state to the rest of the application, and never reproduce on write.
  updatedAtMs: 1_700_000_000_000,
};

/** A minimal fake `PrismaClient` covering only what `PrismaAgentControlStore.get`/`replace`
 * touch for a single Agent row with no Session association — enough to exercise the real
 * parsing and compare-and-swap logic without a live Postgres. */
function fakeDb(initialControlState: unknown) {
  let storedControlState: unknown = initialControlState;
  let lastUpdateData: Record<string, unknown> | undefined;
  let createdSessionRows = 0;
  const base = {
    id: "a",
    ownerId: "owner",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig,
    runtimeSession: null,
    stoppedAt: null,
    currentSessionId: null,
    currentSession: null,
    owner: { memberships: [{ workspaceId: "w" }] },
    computer: { workspaces: [{ workspaceId: "w" }] },
  };
  const agent = {
    findUnique: async ({ select }: { select: Record<string, unknown> }) => {
      // get()'s own read asks for `controlState`; replace()'s internal session-lock read (inside
      // the transaction) does not — that is how this fake tells the two call sites apart.
      if ("controlState" in select) return { ...base, controlState: storedControlState };
      return { currentSessionId: base.currentSessionId, currentSession: base.currentSession };
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { controlState: { equals: unknown } };
      data: Record<string, unknown>;
    }) => {
      // The real predicate compares the JSONB column with Postgres `=` — structural equality,
      // not "same keys after reconstruction." Bun.deepEquals mirrors that here.
      if (!Bun.deepEquals(where.controlState.equals, storedControlState, true)) return { count: 0 };
      storedControlState = data.controlState;
      lastUpdateData = data;
      return { count: 1 };
    },
    update: async () => ({}),
  };
  const db = {
    agent,
    agentSession: {
      // `replace()` mints a fresh Session row when a cleared association coexists with a
      // "starting" phase (the mid-launch invalidate shape below); record instead of throwing.
      create: async () => {
        createdSessionRows++;
        return { id: `minted-session-${createdSessionRows}` };
      },
      updateMany: async () => {
        throw new Error("not expected by this fixture (no Session row involved)");
      },
    },
    $queryRaw: async () => [],
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  } as unknown as PrismaClient;
  return {
    db,
    currentStoredControlState: () => storedControlState,
    lastUpdate: () => lastUpdateData,
  };
}

test("a legacy row with updatedAtMs parses through get(), stripped from the resulting state", async () => {
  const { db } = fakeDb(legacyStoredState);
  const store = new PrismaAgentControlStore(db);
  const agent = await store.get("a");
  expect(agent).toBeDefined();
  expect(agent!.state).not.toHaveProperty("updatedAtMs");
  expect(agent!.state).toMatchObject({ requestId: "legacy", phase: "starting", epoch: 4 });
  // The raw stored JSON (kept only for compare-and-swap) still carries it.
  expect(agent!.storedControlState).toMatchObject({ updatedAtMs: legacyStoredState.updatedAtMs });
});

test("replace() succeeds its compare-and-swap against a legacy row, and the next write drops updatedAtMs", async () => {
  const { db, currentStoredControlState } = fakeDb(legacyStoredState);
  const store = new PrismaAgentControlStore(db);
  const before = await store.get("a");
  if (!before) throw new Error("fixture agent missing");
  const next: AgentControlState = {
    ...(before.state as AgentControlState),
    requestId: "superseding",
    epoch: 5,
    action: "stop",
    phase: "stopping",
  };
  const ok = await store.replace(before, next);
  expect(ok).toBe(true);
  const stored = currentStoredControlState() as Record<string, unknown>;
  expect(stored).not.toHaveProperty("updatedAtMs");
  expect(stored).toMatchObject({ requestId: "superseding", epoch: 5, action: "stop" });
});

test("replace() against a legacy row would lose the CAS if the predicate were rebuilt from the stripped state (control fixture for the fix above)", async () => {
  // This does not call the repository at all — it documents, with the same fake DB semantics,
  // why comparing a *reconstructed* value (one without `updatedAtMs`) against the real stored
  // row (with it) is exactly the bug `storedControlState` fixes.
  const { updatedAtMs: _updatedAtMs, ...reconstructed } = legacyStoredState;
  expect(Bun.deepEquals(reconstructed, legacyStoredState, true)).toBe(false);
});

test("clearSession detaches only the Session association — an invalidate can never clear the in-flight launch's runtimeSession fence (ADR 0040-B)", async () => {
  const { db, lastUpdate } = fakeDb(legacyStoredState);
  const store = new PrismaAgentControlStore(db);
  const before = await store.get("a");
  if (!before) throw new Error("fixture agent missing");
  // The `AgentSessionReceiver.invalidate` shape: the SAME requestId (no superseding operation),
  // identity dropped from the state, and `{ clearSession: true }`. The daemon sends this before
  // the launch's own Session report; `AgentSessions.verify` needs the persisted reference.
  const { identity: _identity, ...fields } = before.state as AgentControlState;
  const ok = await store.replace(before, { ...fields }, { clearSession: true });
  expect(ok).toBe(true);
  const data = lastUpdate()!;
  expect(data.currentSessionId).toBeNull();
  expect(data).not.toHaveProperty("runtimeSession");
});

test("a superseding requestId still clears the runtimeSession fence — the one writer that may", async () => {
  const { db, lastUpdate } = fakeDb(legacyStoredState);
  const store = new PrismaAgentControlStore(db);
  const before = await store.get("a");
  if (!before) throw new Error("fixture agent missing");
  const next: AgentControlState = {
    ...(before.state as AgentControlState),
    requestId: "superseding",
    epoch: 5,
    action: "start",
    phase: "starting",
  };
  const ok = await store.replace(before, next);
  expect(ok).toBe(true);
  const data = lastUpdate()!;
  expect(data.runtimeSession).toBe(Prisma.DbNull);
});
