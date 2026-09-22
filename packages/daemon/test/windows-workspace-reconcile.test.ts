import { expect, test } from "bun:test";

import {
  startWindowsWorkspaceReconcileLoop,
  WINDOWS_WORKSPACE_RECONCILE_MS,
} from "../src/supervisor/windows-workspace-reconcile";

test("reconcile loop is null outside win32", () => {
  expect(
    startWindowsWorkspaceReconcileLoop(async () => {}, { platform: "linux" }),
  ).toBeNull();
  expect(
    startWindowsWorkspaceReconcileLoop(async () => {}, { platform: "darwin" }),
  ).toBeNull();
});

test("win32 reconcile loop schedules reconcile and stops clearing the timer", async () => {
  const calls: number[] = [];
  let scheduled: (() => void) | undefined;
  let cleared = false;
  const loop = startWindowsWorkspaceReconcileLoop(
    async () => {
      calls.push(Date.now());
    },
    {
      platform: "win32",
      intervalMs: WINDOWS_WORKSPACE_RECONCILE_MS,
      setIntervalFn: ((handler: TimerHandler) => {
        scheduled = handler as () => void;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearIntervalFn: (() => {
        cleared = true;
      }) as typeof clearInterval,
    },
  );
  expect(loop).not.toBeNull();
  expect(scheduled).toBeTypeOf("function");
  scheduled!();
  await Bun.sleep(0);
  expect(calls).toHaveLength(1);
  // Overlapping ticks are ignored while reconcile is in flight.
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = startWindowsWorkspaceReconcileLoop(() => blocked, {
    platform: "win32",
    setIntervalFn: ((handler: TimerHandler) => {
      scheduled = handler as () => void;
      return 2 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearIntervalFn: clearInterval,
  });
  scheduled!();
  scheduled!();
  release();
  await Bun.sleep(0);
  slow?.stop();
  loop?.stop();
  expect(cleared).toBe(true);
});

test("win32 reconcile loop reports errors without throwing from the timer", async () => {
  const errors: unknown[] = [];
  let scheduled: (() => void) | undefined;
  const loop = startWindowsWorkspaceReconcileLoop(
    async () => {
      throw new Error("reconcile blew up");
    },
    {
      platform: "win32",
      setIntervalFn: ((handler: TimerHandler) => {
        scheduled = handler as () => void;
        return 3 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearIntervalFn: (() => {}) as typeof clearInterval,
      onError: (error) => errors.push(error),
    },
  );
  scheduled!();
  await Bun.sleep(0);
  expect(errors).toHaveLength(1);
  expect((errors[0] as Error).message).toBe("reconcile blew up");
  loop?.stop();
});
