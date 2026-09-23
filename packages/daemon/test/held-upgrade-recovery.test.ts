import { expect, test } from "bun:test";

import {
  HeldUpgradeRecovery,
  operationAllowsWorkspaceRecovery,
  resolveHeldRequestId,
  selectLegacyHeldRequestId,
  shouldAutoFinishHeldUpgrade,
  terminalAllowsWorkspaceRecovery,
} from "../src/supervisor/held-upgrade-recovery";

class WorkspaceFault extends Error {}

function harness(requestId = "upgrade-1") {
  const calls: string[] = [];
  let failClear = false;
  let failWorkspace = false;
  const recovery = new HeldUpgradeRecovery(true, requestId, {
    settle: async (requestId) => {
      calls.push(`settle:${requestId}`);
    },
    resume: async () => {
      calls.push("resume");
      if (failWorkspace) throw new WorkspaceFault("one child failed");
    },
    clearHold: async () => {
      calls.push("clear");
      if (failClear) throw new Error("hold unlink failed");
    },
    isWorkspaceRecoveryError: (error) => error instanceof WorkspaceFault,
    onWorkspaceRecoveryError: (error) => calls.push(`workspace-error:${error.message}`),
  });
  return {
    calls,
    recovery,
    failClear: (value: boolean) => {
      failClear = value;
    },
    failWorkspace: (value: boolean) => {
      failWorkspace = value;
    },
  };
}

test("persisted request ownership wins; only the literal legacy marker falls back", () => {
  const operations = [
    { requestId: "older", state: "pending" as const, requestedAt: 1 },
    { requestId: "current", state: "succeeded" as const, requestedAt: 2 },
  ];
  expect(resolveHeldRequestId("current", operations)).toBe("current");
  expect(resolveHeldRequestId("upgrade", operations)).toBe("current");
  expect(resolveHeldRequestId("unknown-uuid", operations)).toBeUndefined();
  expect(resolveHeldRequestId("", operations)).toBeUndefined();
});

test("newest operation owns a legacy launch-hold across unrelated bindings", () => {
  expect(
    selectLegacyHeldRequestId([
      { requestId: "older-pending", state: "pending", requestedAt: 1 },
      { requestId: "current-terminal", state: "succeeded", requestedAt: 2 },
    ]),
  ).toBe("current-terminal");

  expect(
    selectLegacyHeldRequestId([
      { requestId: "older-terminal", state: "succeeded", requestedAt: 1 },
      { requestId: "current-pending", state: "pending", requestedAt: 2 },
    ]),
  ).toBe("current-pending");
});

test("Coordinator restart resumes the newest verified unacknowledged terminal operation", () => {
  expect(
    selectLegacyHeldRequestId([
      { requestId: "acknowledged", state: "acknowledged", requestedAt: 1 },
      {
        requestId: "broken-rollback",
        state: "failed",
        requestedAt: 3,
        terminal: { errorCode: "UPGRADE_ROLLBACK_FAILED" },
      },
      {
        requestId: "restored",
        state: "failed",
        requestedAt: 4,
        terminal: { errorCode: "UPGRADE_ROLLED_BACK" },
      },
    ]),
  ).toBe("restored");
});

test("acknowledged success remains sufficient to clear a leftover hold", () => {
  expect(
    operationAllowsWorkspaceRecovery({
      requestId: "success",
      state: "acknowledged",
      requestedAt: 1,
      terminal: { version: "2.0.0" },
    }),
  ).toBe(true);
  expect(
    operationAllowsWorkspaceRecovery({
      requestId: "failed",
      state: "acknowledged",
      requestedAt: 2,
      terminal: { error: "rollback failed", errorCode: "UPGRADE_ROLLBACK_FAILED" },
    }),
  ).toBe(false);
});

test("only verified promotion or rollback terminal results release launch-hold", () => {
  expect(terminalAllowsWorkspaceRecovery({ status: "succeeded" })).toBe(true);
  expect(
    terminalAllowsWorkspaceRecovery({ status: "failed", errorCode: "UPGRADE_ROLLED_BACK" }),
  ).toBe(true);
  expect(
    terminalAllowsWorkspaceRecovery({ status: "failed", errorCode: "UPGRADE_ROLLBACK_FAILED" }),
  ).toBe(false);
  expect(terminalAllowsWorkspaceRecovery({ status: "failed" })).toBe(false);
});

test("a Coordinator restart self-completes terminal receipt plus launch-hold without an external RPC", async () => {
  const { calls, recovery } = harness();

  // Startup sweep/watcher already settled the durable receipt before invoking this seam.
  await recovery.finish("upgrade-1", true);

  expect(calls).toEqual(["resume", "clear"]);
  expect(recovery.active).toBe(false);
  // Models an external resume response lost after the side effects: retry is a no-op.
  await recovery.finish("upgrade-1");
  expect(calls).toEqual(["resume", "clear"]);
});

test("stranded launch-hold without an owner recovers on explicit resume without settle", async () => {
  // Local CLI upgrades write a UUID into launch-hold without recordUpgrade, so
  // resolveHeldRequestId leaves the owner undefined. Explicit daemon:resume must
  // still resume Workspaces and clear the hold; settle has nothing to bind to.
  const calls: string[] = [];
  const recovery = new HeldUpgradeRecovery(true, undefined, {
    settle: async () => {
      calls.push("settle");
    },
    resume: async () => {
      calls.push("resume");
    },
    clearHold: async () => {
      calls.push("clear");
    },
    isWorkspaceRecoveryError: () => false,
    onWorkspaceRecoveryError: () => {},
  });

  expect(recovery.owns("cli-local-request")).toBe(false);
  expect(shouldAutoFinishHeldUpgrade(recovery, "cli-local-request", { status: "succeeded" })).toBe(
    false,
  );

  await recovery.finish("cli-local-request");

  expect(calls).toEqual(["resume", "clear"]);
  expect(recovery.active).toBe(false);
  await recovery.finish("cli-local-request");
  expect(calls).toEqual(["resume", "clear"]);
});

test("explicit settlement does not deadlock by re-entering its watcher callback", async () => {
  const calls: string[] = [];
  let guardSawFinishing = false;
  let recovery!: HeldUpgradeRecovery;
  recovery = new HeldUpgradeRecovery(true, "exact", {
    settle: async (requestId) => {
      calls.push(`settle:${requestId}`);
      guardSawFinishing = recovery.isFinishing(requestId);
      if (shouldAutoFinishHeldUpgrade(recovery, requestId, { status: "succeeded" }))
        await recovery.finish(requestId, true);
    },
    resume: async () => {
      calls.push("resume");
    },
    clearHold: async () => {
      calls.push("clear");
    },
    isWorkspaceRecoveryError: () => false,
    onWorkspaceRecoveryError: () => {},
  });

  await recovery.finish("exact");
  expect(guardSawFinishing).toBe(true);
  expect(calls).toEqual(["settle:exact", "resume", "clear"]);
});

test("an unrelated receipt cannot join or release another request's launch-hold", async () => {
  const { calls, recovery } = harness("current");

  await expect(recovery.finish("unrelated", true)).rejects.toThrow(
    "does not own launch-hold for current",
  );
  expect(calls).toEqual([]);
  expect(recovery.active).toBe(true);
});

test("explicit resume settles the exact receipt before reconciling and clearing hold", async () => {
  const { calls, recovery } = harness("upgrade-exact");

  await recovery.finish("upgrade-exact");
  expect(calls).toEqual(["settle:upgrade-exact", "resume", "clear"]);
  expect(recovery.active).toBe(false);
});

test("post-commit Workspace recovery failure is reported but still releases machine hold", async () => {
  const { calls, recovery, failWorkspace } = harness();
  failWorkspace(true);

  await recovery.finish("upgrade-1", true);

  expect(calls).toEqual(["resume", "workspace-error:one child failed", "clear"]);
  expect(recovery.active).toBe(false);
});

test("hold removal failure stays active and retries instead of claiming completion", async () => {
  const { calls, recovery, failClear } = harness();
  failClear(true);

  await expect(recovery.finish("upgrade-1", true)).rejects.toThrow("hold unlink failed");
  expect(recovery.active).toBe(true);

  failClear(false);
  await recovery.finish("upgrade-1", true);
  expect(calls).toEqual(["resume", "clear", "resume", "clear"]);
  expect(recovery.active).toBe(false);
});
