import { expect, test } from "bun:test";
import {
  COLLECT_SLOT_STATUS,
  COLLECT_RUN_STATUS,
  allSlotsTerminal,
  canSynthesizeFromSlots,
  isRetryableSlotStatus,
} from "../src/server/records/weekly-report-collect-run.server";
import {
  WEEKLY_REPORT_COLLECTOR_DISPLAY_NAME_PREFIX,
  weeklyReportCollectorAgentName,
  weeklyReportCollectorDisplayName,
} from "../src/server/records/weekly-report-collector.server";

test("collector Agent names stay stable and User-Computer scoped", () => {
  expect(weeklyReportCollectorAgentName("computer-a")).toBe(
    "weekly-report-collector-computer-a",
  );
  expect(weeklyReportCollectorAgentName("computer-b")).not.toBe(
    weeklyReportCollectorAgentName("computer-a"),
  );
  expect(WEEKLY_REPORT_COLLECTOR_DISPLAY_NAME_PREFIX).toBe("采集 · ");
  expect(weeklyReportCollectorDisplayName("Pi (ubuntu)")).toBe("采集 · Pi (ubuntu)");
});

test("collect slot settle helpers match ADR 0032 terminal and partial-success rules", () => {
  expect(allSlotsTerminal([])).toBe(true);
  expect(
    allSlotsTerminal([
      { status: COLLECT_SLOT_STATUS.ready },
      { status: COLLECT_SLOT_STATUS.failed },
    ]),
  ).toBe(true);
  expect(
    allSlotsTerminal([
      { status: COLLECT_SLOT_STATUS.ready },
      { status: COLLECT_SLOT_STATUS.running },
    ]),
  ).toBe(false);

  expect(
    canSynthesizeFromSlots([
      { status: COLLECT_SLOT_STATUS.ready },
      { status: COLLECT_SLOT_STATUS.failed },
    ]),
  ).toBe(true);
  expect(
    canSynthesizeFromSlots([
      { status: COLLECT_SLOT_STATUS.empty },
      { status: COLLECT_SLOT_STATUS.failed },
    ]),
  ).toBe(false);
  expect(
    canSynthesizeFromSlots([
      { status: COLLECT_SLOT_STATUS.ready },
      { status: COLLECT_SLOT_STATUS.running },
    ]),
  ).toBe(false);

  expect(isRetryableSlotStatus(COLLECT_SLOT_STATUS.failed)).toBe(true);
  expect(isRetryableSlotStatus(COLLECT_SLOT_STATUS.stalled)).toBe(true);
  expect(isRetryableSlotStatus(COLLECT_SLOT_STATUS.empty)).toBe(false);
  expect(isRetryableSlotStatus(COLLECT_SLOT_STATUS.ready)).toBe(false);
});

test("startCollectRun rejects foreign computers and zero ready collectors", async () => {
  const { startCollectRun } = await import(
    "../src/server/records/weekly-report-collect-run.server"
  );
  const { AppError } = await import("../src/lib/app-error");

  const db = {
    weeklyReport: {
      findFirst: async () => ({
        id: "report-1",
        workspaceId: "ws-1",
        authorId: "user-1",
        kind: "member",
      }),
    },
    weeklyReportCollectorBinding: {
      findMany: async () => [
        {
          id: "b1",
          workspaceId: "ws-1",
          userId: "user-1",
          computerId: "computer-owned",
          collectorAgentId: "agent-1",
        },
      ],
    },
    agent: {
      findMany: async () => [
        {
          id: "agent-1",
          computerId: "computer-owned",
          runtimeConfig: { runtime: "pi", provider: { kind: "default" } },
        },
      ],
    },
    workspaceComputer: {
      findMany: async () => [
        {
          computerId: "computer-owned",
          computer: { id: "computer-owned", ownerId: "user-1" },
        },
        {
          computerId: "computer-other",
          computer: { id: "computer-other", ownerId: "user-2" },
        },
      ],
    },
    weeklyReportCollectRun: {
      create: async () => {
        throw new Error("must not create");
      },
    },
  };

  await expect(
    startCollectRun(db as never, {
      workspaceId: "ws-1",
      userId: "user-1",
      reportId: "report-1",
      windowKind: "week",
      windowStart: new Date("2026-08-31T00:00:00.000Z"),
      windowEnd: new Date("2026-09-07T00:00:00.000Z"),
      computers: [{ computerId: "computer-other", scanPaths: ["/tmp"] }],
    }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" } satisfies Partial<InstanceType<typeof AppError>>);

  await expect(
    startCollectRun(db as never, {
      workspaceId: "ws-1",
      userId: "user-1",
      reportId: "report-1",
      windowKind: "week",
      windowStart: new Date("2026-08-31T00:00:00.000Z"),
      windowEnd: new Date("2026-09-07T00:00:00.000Z"),
      computers: [],
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

test("ensureCollector refuses a Computer the User does not own", async () => {
  const { ensureCollector } = await import(
    "../src/server/records/weekly-report-collector.server"
  );

  const db = {
    weeklyReportCollectorBinding: {
      findUnique: async () => null,
    },
    $transaction: async (fn: (tx: typeof db) => Promise<unknown>) => fn(db),
    workspaceComputer: {
      findUnique: async () => ({
        computerId: "computer-1",
        computer: {
          id: "computer-1",
          ownerId: "other-user",
          displayName: "Pi",
          name: "pi",
        },
      }),
    },
  };

  await expect(
    ensureCollector(db as never, {
      workspaceId: "ws-1",
      userId: "user-1",
      computerId: "computer-1",
    }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
});

test("startCollectRun creates a collecting run with running slots for ready collectors", async () => {
  const { startCollectRun, COLLECT_RUN_STATUS, COLLECT_SLOT_STATUS } = await import(
    "../src/server/records/weekly-report-collect-run.server"
  );

  let created: Record<string, unknown> | null = null;
  const db = {
    weeklyReport: {
      findFirst: async () => ({
        id: "report-1",
        workspaceId: "ws-1",
        authorId: "user-1",
        kind: "member",
      }),
    },
    workspaceComputer: {
      findMany: async () => [
        {
          computerId: "computer-1",
          computer: { id: "computer-1", ownerId: "user-1" },
        },
      ],
    },
    weeklyReportCollectorBinding: {
      findMany: async () => [
        {
          id: "b1",
          workspaceId: "ws-1",
          userId: "user-1",
          computerId: "computer-1",
          collectorAgentId: "agent-1",
        },
      ],
    },
    agent: {
      findMany: async () => [
        {
          id: "agent-1",
          computerId: "computer-1",
          runtimeConfig: { runtime: "pi", provider: { kind: "default" } },
        },
      ],
    },
    weeklyReportCollectRun: {
      create: async ({
        data,
        include,
      }: {
        data: Record<string, unknown>;
        include: { slots: boolean };
      }) => {
        expect(include.slots).toBe(true);
        const slotCreate = data.slots as { create: Array<Record<string, unknown>> };
        created = {
          id: "run-1",
          reportId: data.reportId,
          status: data.status,
          windowKind: data.windowKind,
          windowStart: data.windowStart,
          windowEnd: data.windowEnd,
          startedAt: data.startedAt,
          completedAt: null,
          createdAt: new Date("2026-09-17T00:00:00.000Z"),
          slots: slotCreate.create.map((slot, index) => ({
            id: `slot-${index}`,
            computerId: slot.computerId,
            collectorAgentId: slot.collectorAgentId,
            scanPaths: slot.scanPaths,
            status: slot.status,
            retryCount: slot.retryCount,
            failureReason: null,
            packMarkdown: null,
          })),
        };
        return created;
      },
    },
  };

  const view = await startCollectRun(db as never, {
    workspaceId: "ws-1",
    userId: "user-1",
    reportId: "report-1",
    windowKind: "week",
    windowStart: new Date("2026-08-31T00:00:00.000Z"),
    windowEnd: new Date("2026-09-07T00:00:00.000Z"),
    computers: [{ computerId: "computer-1", scanPaths: ["/home/jian40/work"] }],
  });

  expect(view.status).toBe(COLLECT_RUN_STATUS.collecting);
  expect(view.slots).toHaveLength(1);
  expect(view.slots[0]).toMatchObject({
    computerId: "computer-1",
    collectorAgentId: "agent-1",
    scanPaths: ["/home/jian40/work"],
    status: COLLECT_SLOT_STATUS.running,
    hasPack: false,
  });
  expect(view.allTerminal).toBe(false);
  expect(view.canSynthesize).toBe(false);
  expect(created).not.toBeNull();
});
