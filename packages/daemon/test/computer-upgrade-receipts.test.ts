import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computerUpgradeResultPath,
  readComputerUpgradeReceipt,
  sweepComputerUpgradeReceipts,
  watchComputerUpgradeReceipt,
  UPGRADE_EXPIRED_WITHOUT_RECEIPT,
} from "../src/platform/computer-upgrade-receipts";
import {
  MachineSupervisor,
  UPGRADE_OPERATION_PENDING_TTL_MS,
  type ManagedBinding,
} from "../src/supervisor/machine-supervisor";

async function home() {
  return await mkdtemp(join(realpathSync(tmpdir()), "coforge-upgrade-receipt-"));
}

async function writeReceipt(homeDirectory: string, requestId: string, value: unknown) {
  await Bun.write(computerUpgradeResultPath(requestId, homeDirectory), JSON.stringify(value));
}

test("a pending operation has no receipt until its job writes one", async () => {
  const homeDirectory = await home();
  try {
    expect(await readComputerUpgradeReceipt("absent", { homeDirectory })).toBeUndefined();
    await writeReceipt(homeDirectory, "request-a", {
      schema_version: 1,
      request_id: "request-a",
      operation: "upgrade",
      status: "succeeded",
      version: "0.1.0-dev.29",
    });
    expect(await readComputerUpgradeReceipt("request-a", { homeDirectory })).toMatchObject({
      requestId: "request-a",
      status: "succeeded",
      version: "0.1.0-dev.29",
    });
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("a receipt that names another operation, or no known status, is not evidence", async () => {
  const homeDirectory = await home();
  try {
    await writeReceipt(homeDirectory, "request-a", {
      schema_version: 1,
      request_id: "someone-else",
      status: "succeeded",
    });
    expect(await readComputerUpgradeReceipt("request-a", { homeDirectory })).toBeUndefined();
    await writeReceipt(homeDirectory, "request-b", { schema_version: 1, status: "running" });
    expect(await readComputerUpgradeReceipt("request-b", { homeDirectory })).toBeUndefined();
    await Bun.write(computerUpgradeResultPath("request-c", homeDirectory), "{ not json");
    expect(await readComputerUpgradeReceipt("request-c", { homeDirectory })).toBeUndefined();
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("the sweep settles only the pending operations whose job already finished", async () => {
  const homeDirectory = await home();
  try {
    await writeReceipt(homeDirectory, "done", {
      schema_version: 1,
      request_id: "done",
      status: "failed",
      error: "candidate failed",
    });
    const settled: { workspaceId: string; requestId: string; status: string }[] = [];
    const resolved = await sweepComputerUpgradeReceipts(
      [
        { workspaceId: "a", requestId: "done", requestedAt: 0 },
        { workspaceId: "a", requestId: "still-running", requestedAt: 0 },
      ],
      async (workspaceId, requestId, receipt) => {
        settled.push({ workspaceId, requestId, status: receipt.status });
      },
      { homeDirectory },
    );

    expect(resolved).toBe(1);
    expect(settled).toEqual([{ workspaceId: "a", requestId: "done", status: "failed" }]);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("a pending operation without a receipt expires once, and only past its TTL", async () => {
  const homeDirectory = await home();
  try {
    const now = 10 * 60_000;
    const expired: Record<string, unknown>[] = [];
    const sweep = (requestedAt: number) =>
      sweepComputerUpgradeReceipts(
        [{ workspaceId: "a", requestId: "stranded", requestedAt }],
        async (workspaceId, _requestId, receipt) => {
          expired.push({ workspaceId, ...receipt });
        },
        { homeDirectory, now: () => now, pendingTtlMs: 5 * 60_000 },
      );

    // Still inside the window: the job may simply be slow, so nothing is concluded.
    expect(await sweep(now - 4 * 60_000)).toBe(0);
    expect(expired).toEqual([]);

    expect(await sweep(now - 6 * 60_000)).toBe(1);
    expect(expired).toEqual([
      {
        workspaceId: "a",
        requestId: "stranded",
        status: "failed",
        error: UPGRADE_EXPIRED_WITHOUT_RECEIPT,
        at: now,
      },
    ]);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("an expired operation stops blocking the next request; a live one still blocks", async () => {
  const homeDirectory = await home();
  const now = 60 * 60_000;
  const supervisor = (requestedAt: number) => {
    let saved: ManagedBinding[] = [
      {
        workspaceId: "a",
        computerId: "c",
        workspaceRoot: "/a",
        enabled: true,
        upgradeOperations: [
          { requestId: "stranded", expectedVersion: "1.0.0", state: "pending", requestedAt },
        ],
      },
    ];
    return new MachineSupervisor(
      {
        load: async () => structuredClone(saved),
        save: async (next) => {
          saved = structuredClone(next);
        },
      },
      { start: async () => "a", stop: async () => {}, instance: async () => "a" },
      () => now,
    );
  };
  const settle = (machine: MachineSupervisor, requestedAt: number) =>
    sweepComputerUpgradeReceipts(
      [{ workspaceId: "a", requestId: "stranded", requestedAt }],
      (workspaceId, requestId, receipt) =>
        machine.completeUpgrade(workspaceId, requestId, {
          status: receipt.status,
          at: receipt.at,
          ...(receipt.error ? { error: receipt.error } : {}),
        }),
      { homeDirectory, now: () => now, pendingTtlMs: UPGRADE_OPERATION_PENDING_TTL_MS },
    );

  try {
    const stale = supervisor(now - UPGRADE_OPERATION_PENDING_TTL_MS - 1);
    await stale.recover();
    await settle(stale, now - UPGRADE_OPERATION_PENDING_TTL_MS - 1);
    expect(await stale.recordUpgrade("a", "fresh", "2.0.0")).toBe(true);

    const live = supervisor(now - 1_000);
    await live.recover();
    await settle(live, now - 1_000);
    await expect(live.recordUpgrade("a", "fresh", "2.0.0")).rejects.toThrow(
      "stranded is still pending",
    );
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("the continuous post-startup watch settles a receipt the startup sweep missed, without another restart", async () => {
  // Reproduces the 2026-09-17 incident at the closest seam: the Coordinator's "startup sweep"
  // (`sweepComputerUpgradeReceipts`) runs before the job's receipt exists - the job writes it only
  // after a later handshake/probe - so the operation stays pending. Only a later Coordinator start
  // used to ever look again; this asserts the continuous watch settles it within the same process
  // instead, and that a second `recordUpgrade` is then accepted.
  const homeDirectory = await home();
  const requestedAt = 0;
  let saved: ManagedBinding[] = [
    { workspaceId: "a", computerId: "c", workspaceRoot: "/a", enabled: true },
  ];
  const machine = new MachineSupervisor(
    {
      load: async () => structuredClone(saved),
      save: async (next) => {
        saved = structuredClone(next);
      },
    },
    { start: async () => "a", stop: async () => {}, instance: async () => "a" },
    () => requestedAt,
  );
  try {
    await machine.recover();
    expect(await machine.recordUpgrade("a", "req-1", "2.0.0")).toBe(true);

    // "Coordinator start" sweep: the job has not written its receipt yet, so nothing settles.
    const startupSweepResolved = await sweepComputerUpgradeReceipts(
      [{ workspaceId: "a", requestId: "req-1", requestedAt }],
      (workspaceId, requestId, receipt) =>
        machine.completeUpgrade(workspaceId, requestId, {
          status: receipt.status,
          at: receipt.at,
          ...(receipt.version ? { version: receipt.version } : {}),
        }),
      { homeDirectory, now: () => requestedAt, pendingTtlMs: UPGRADE_OPERATION_PENDING_TTL_MS },
    );
    expect(startupSweepResolved).toBe(0);
    expect(saved[0]?.upgradeOperations?.[0]?.state).toBe("pending");

    // The job finishes after the startup sweep already ran, as it does in the field.
    await writeReceipt(homeDirectory, "req-1", {
      schema_version: 1,
      request_id: "req-1",
      status: "succeeded",
      version: "2.0.0",
    });

    // The continuous watch, still running in this same process, finds it on its next check.
    await watchComputerUpgradeReceipt(
      { workspaceId: "a", requestId: "req-1", requestedAt },
      (workspaceId, requestId, receipt) =>
        machine.completeUpgrade(workspaceId, requestId, {
          status: receipt.status,
          at: receipt.at,
          ...(receipt.version ? { version: receipt.version } : {}),
        }),
      {
        signal: new AbortController().signal,
        pollMs: 5,
        ttlMs: UPGRADE_OPERATION_PENDING_TTL_MS,
        homeDirectory,
        now: () => requestedAt,
      },
    );

    expect(saved[0]?.upgradeOperations?.[0]?.state).toBe("succeeded");
    expect(await machine.acknowledgeUpgrade("a", "req-1")).toBe(true);
    expect(saved[0]?.upgradeOperations?.[0]?.state).toBe("acknowledged");

    // Settled without another restart: a second upgrade request is now accepted, not refused.
    expect(await machine.recordUpgrade("a", "req-2", "2.0.1")).toBe(true);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

describe("watchComputerUpgradeReceipt", () => {
  test("settles when a receipt appears on a later poll", async () => {
    const homeDirectory = await home();
    try {
      const settled: { workspaceId: string; requestId: string; status: string }[] = [];
      let polls = 0;
      await watchComputerUpgradeReceipt(
        { workspaceId: "a", requestId: "request-a", requestedAt: 0 },
        async (workspaceId, requestId, receipt) => {
          settled.push({ workspaceId, requestId, status: receipt.status });
        },
        {
          signal: new AbortController().signal,
          pollMs: 10,
          ttlMs: 60_000,
          homeDirectory,
          now: () => 0,
          sleep: async () => {
            polls += 1;
            // The job only leaves its receipt after the first poll finds nothing.
            await writeReceipt(homeDirectory, "request-a", {
              schema_version: 1,
              request_id: "request-a",
              status: "succeeded",
              version: "1.2.3",
            });
          },
        },
      );
      expect(polls).toBe(1);
      expect(settled).toEqual([{ workspaceId: "a", requestId: "request-a", status: "succeeded" }]);
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  test("settles as failed and expired once the pending TTL passes, without a receipt", async () => {
    const homeDirectory = await home();
    try {
      let now = 0;
      let polls = 0;
      const settled: Record<string, unknown>[] = [];
      await watchComputerUpgradeReceipt(
        { workspaceId: "a", requestId: "stranded", requestedAt: 0 },
        async (workspaceId, _requestId, receipt) => {
          settled.push({ workspaceId, ...receipt });
        },
        {
          signal: new AbortController().signal,
          pollMs: 10,
          ttlMs: 30,
          homeDirectory,
          now: () => now,
          sleep: async () => {
            polls += 1;
            now += 20;
          },
        },
      );
      expect(polls).toBe(2);
      expect(settled).toEqual([
        {
          workspaceId: "a",
          requestId: "stranded",
          status: "failed",
          error: UPGRADE_EXPIRED_WITHOUT_RECEIPT,
          at: 40,
        },
      ]);
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  test("stops promptly when the signal aborts, without settling", async () => {
    const homeDirectory = await home();
    try {
      const controller = new AbortController();
      let sleepCalls = 0;
      const settled: unknown[] = [];
      await watchComputerUpgradeReceipt(
        { workspaceId: "a", requestId: "never", requestedAt: 0 },
        async (...args) => {
          settled.push(args);
        },
        {
          signal: controller.signal,
          pollMs: 10,
          // A TTL this far out proves the abort - not the TTL - is what stopped the watch.
          ttlMs: 10 * 60_000,
          homeDirectory,
          now: () => 0,
          sleep: async () => {
            sleepCalls += 1;
            if (sleepCalls === 2) controller.abort();
          },
        },
      );
      expect(sleepCalls).toBe(2);
      expect(settled).toEqual([]);
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  test("does nothing beyond its first check when the operation already has a receipt", async () => {
    const homeDirectory = await home();
    try {
      await writeReceipt(homeDirectory, "request-a", {
        schema_version: 1,
        request_id: "request-a",
        status: "succeeded",
      });
      const settled: string[] = [];
      await watchComputerUpgradeReceipt(
        { workspaceId: "a", requestId: "request-a", requestedAt: 0 },
        async (_workspaceId, requestId) => {
          settled.push(requestId);
        },
        {
          signal: new AbortController().signal,
          pollMs: 10,
          ttlMs: 60_000,
          homeDirectory,
          sleep: async () => {
            throw new Error("should never sleep when a receipt is already available");
          },
        },
      );
      expect(settled).toEqual(["request-a"]);
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  test("a real process exits promptly once aborted, even with a ten-minute budget (ADR 0037)", async () => {
    // The 2026-09-17 incident: an uncancelled receipt watch's pending `Bun.sleep` kept the
    // Coordinator alive past its own shutdown, past launchd's 5s SIGKILL window. Only a real
    // process exit can prove no timer is left pending, so this measures one.
    const watchHomeDirectory = await home();
    try {
      const source = `
        import { watchComputerUpgradeReceipt } from ${JSON.stringify(
          join(import.meta.dir, "../src/platform/computer-upgrade-receipts"),
        )};
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);
        await watchComputerUpgradeReceipt(
          { workspaceId: "a", requestId: "never", requestedAt: 0 },
          async () => {},
          {
            signal: controller.signal,
            pollMs: 10 * 60_000,
            ttlMs: 10 * 60_000,
            homeDirectory: ${JSON.stringify(watchHomeDirectory)},
            now: () => 0,
          },
        );
        console.log("exited");
      `;
      const started = performance.now();
      const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
      const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect({ code, stdout: stdout.trim() }).toEqual({ code: 0, stdout: "exited" });
      expect(performance.now() - started).toBeLessThan(3_000);
    } finally {
      await rm(watchHomeDirectory, { recursive: true, force: true });
    }
  });
});
