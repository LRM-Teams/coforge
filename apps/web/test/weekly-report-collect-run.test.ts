import { expect, test } from "bun:test";
import {
  COLLECT_SLOT_STATUS,
  allSlotsTerminal,
  canSynthesizeFromSlots,
  isRetryableSlotStatus,
} from "@/server/records/weekly-report-collect-run.server";
import {
  WEEKLY_REPORT_COLLECTOR_DISPLAY_NAME_PREFIX,
  weeklyReportCollectorAgentName,
  weeklyReportCollectorDisplayName,
} from "@/server/records/weekly-report-collector.server";

test("collector Agent names stay stable and User-Computer scoped", () => {
  expect(weeklyReportCollectorAgentName("computer-a")).toBe("weekly-report-collector-computer-a");
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

test("collectWaveExhausted is true only when every slot is terminal with no ready pack", async () => {
  const { COLLECT_SLOT_STATUS, collectWaveExhausted } =
    await import("@/server/records/weekly-report-collect-run.server");
  expect(collectWaveExhausted([])).toBe(false);
  expect(
    collectWaveExhausted([
      { status: COLLECT_SLOT_STATUS.failed },
      { status: COLLECT_SLOT_STATUS.empty },
    ]),
  ).toBe(true);
  expect(
    collectWaveExhausted([
      { status: COLLECT_SLOT_STATUS.ready },
      { status: COLLECT_SLOT_STATUS.failed },
    ]),
  ).toBe(false);
  expect(collectWaveExhausted([{ status: COLLECT_SLOT_STATUS.running }])).toBe(false);
});

test("startCollectRun rejects foreign computers and zero ready collectors", async () => {
  const { startCollectRun } = await import("@/server/records/weekly-report-collect-run.server");
  const { AppError } = await import("@/lib/app-error");

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
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" } satisfies Partial<
    InstanceType<typeof AppError>
  >);

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
  const { ensureCollector } = await import("@/server/records/weekly-report-collector.server");

  const db: any = {
    weeklyReportCollectorBinding: {
      findUnique: async () => null,
    },
    $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(db),
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

test("ensureCollector creates a private Collector Agent for an owned Computer", async () => {
  const { ensureCollector } = await import("@/server/records/weekly-report-collector.server");
  const createdAgents: Array<Record<string, unknown>> = [];
  const db: any = {
    $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(db),
    weeklyReportCollectorBinding: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        id: "binding-1",
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    },
    workspaceComputer: {
      findUnique: async () => ({
        computerId: "computer-a",
        computer: {
          id: "computer-a",
          ownerId: "user-1",
          displayName: "ubuntu",
          name: "ubuntu",
        },
      }),
    },
    agent: {
      findUnique: async () => null,
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const agent = { ...data, id: "collector-1" };
        createdAgents.push(agent);
        return agent;
      },
    },
    conversation: {
      createMany: async () => ({ count: 0 }),
      findUniqueOrThrow: async () => ({ id: "general-1" }),
    },
    workspaceMembership: {
      findMany: async () => [{ userId: "user-1" }],
    },
    conversationMember: {
      createMany: async () => ({ count: 0 }),
    },
    message: {
      findFirst: async () => undefined,
    },
  };

  const result = await ensureCollector(db as never, {
    workspaceId: "ws-1",
    userId: "user-1",
    computerId: "computer-a",
  });

  expect(result.collectorAgentId).toBe("collector-1");
  expect(createdAgents[0]).toMatchObject({
    visibility: "private",
    name: "weekly-report-collector-computer-a",
    ownerId: "user-1",
  });
});

test("ensureCollector reclaims an orphan Agent and creates the missing binding", async () => {
  const { ensureCollector } = await import("@/server/records/weekly-report-collector.server");
  let createdBinding: unknown = null;
  let visibilityPatch: unknown = null;
  const db: any = {
    $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(db),
    weeklyReportCollectorBinding: {
      findUnique: async () => null,
      create: async ({ data }: { data: unknown }) => {
        createdBinding = data;
        return {
          id: "binding-1",
          ...(data as object),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
    },
    workspaceComputer: {
      findUnique: async () => ({
        computerId: "computer-a",
        computer: {
          id: "computer-a",
          ownerId: "user-1",
          displayName: "ubuntu",
          name: "ubuntu",
        },
      }),
    },
    agent: {
      findUnique: async () => ({
        id: "orphan-agent",
        ownerId: "user-1",
        computerId: "computer-a",
        visibility: "public",
      }),
      findMany: async () => [{ id: "orphan-agent" }],
      create: async () => {
        throw new Error("must not create duplicate agent");
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if (data.visibility != null) visibilityPatch = data;
        return {};
      },
    },
    conversation: {
      createMany: async () => ({ count: 0 }),
      findUniqueOrThrow: async () => ({ id: "general-1" }),
    },
    workspaceMembership: {
      findMany: async () => [{ userId: "user-1" }],
    },
    conversationMember: {
      createMany: async () => ({ count: 0 }),
    },
    message: {
      findFirst: async () => undefined,
    },
  };

  const result = await ensureCollector(db as never, {
    workspaceId: "ws-1",
    userId: "user-1",
    computerId: "computer-a",
  });

  expect(result.collectorAgentId).toBe("orphan-agent");
  expect(createdBinding).toMatchObject({
    workspaceId: "ws-1",
    userId: "user-1",
    computerId: "computer-a",
    collectorAgentId: "orphan-agent",
  });
  expect(visibilityPatch).toMatchObject({ visibility: "private" });
});

test("startCollectRun creates a collecting run with running slots for ready collectors", async () => {
  const { startCollectRun, COLLECT_RUN_STATUS, COLLECT_SLOT_STATUS } =
    await import("@/server/records/weekly-report-collect-run.server");

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

test("buildCollectSynthesizerWakeText includes status board and ready packs", async () => {
  const { buildCollectSynthesizerWakeText } =
    await import("@/server/records/weekly-report-collect-orchestrate.server");
  const text = buildCollectSynthesizerWakeText({
    reportId: "report-1",
    runId: "run-1",
    slots: [
      {
        computerLabel: "ubuntu",
        status: "ready",
        packMarkdown: "## Evidence\n- shipped feature",
        failureReason: null,
      },
      {
        computerLabel: "mac",
        status: "failed",
        packMarkdown: null,
        failureReason: "auth expired",
      },
    ],
  });
  expect(text).toContain("reportId=report-1");
  expect(text).toContain("- ubuntu: ready");
  expect(text).toContain("- mac: failed: auth expired");
  expect(text).toContain("### Pack · ubuntu");
  expect(text).toContain("shipped feature");
  expect(text).toContain("[weekly-report-suggestion]");
  expect(text).toContain("采集包应已按作者过滤");
  expect(text).not.toContain("用户调整要求");
});

test("buildCollectorWakeBody requires owner-scoped harvest and lists identity hints", async () => {
  const { buildCollectorWakeBody } =
    await import("@/server/records/weekly-report-collect-orchestrate.server");
  const text = buildCollectorWakeBody({
    runId: "run-1",
    reportId: "report-1",
    slotId: "slot-1",
    windowStart: new Date("2026-09-14T00:00:00.000Z"),
    windowEnd: new Date("2026-09-21T00:00:00.000Z"),
    scanPaths: ["/home/jian40/Coforge"],
    ownerUsername: "lijiannankai-95827c9b",
    ownerDisplayName: "Li Jian",
    ownerGitHubLogin: "lijiannankai",
  });
  expect(text).toContain("只采集本报告作者本人的工作");
  expect(text).toContain("ownerUsername=lijiannankai-95827c9b");
  expect(text).toContain("ownerDisplayName=Li Jian");
  expect(text).toContain("ownerGitHubLogin=lijiannankai");
  expect(text).toContain("- /home/jian40/Coforge");
});

test("buildCollectSynthesizerWakeText forwards user revision guidance", async () => {
  const { buildCollectSynthesizerWakeText } =
    await import("@/server/records/weekly-report-collect-orchestrate.server");
  const text = buildCollectSynthesizerWakeText({
    reportId: "report-1",
    runId: "run-1",
    userGuidance: "刚才整理的周报太细碎了，帮我抽取的更概括一些",
    slots: [
      {
        computerLabel: "ubuntu",
        status: "ready",
        packMarkdown: "## Evidence\n- shipped feature",
        failureReason: null,
      },
    ],
  });
  expect(text).toContain("## 用户调整要求");
  expect(text).toContain("刚才整理的周报太细碎了，帮我抽取的更概括一些");
});

test("acceptCollectSlotReport advances collecting→synthesizing when every slot is ready", async () => {
  const { acceptCollectSlotReport, COLLECT_RUN_STATUS, COLLECT_SLOT_STATUS } =
    await import("@/server/records/weekly-report-collect-run.server");

  let slotStatus: string = COLLECT_SLOT_STATUS.running;
  let slotRequestId: string | null = null;
  let slotPack: string | null = null;
  let runStatus: string = COLLECT_RUN_STATUS.collecting;
  let runCompletedAt: Date | null = null;

  const slotRow = () => ({
    id: "slot-1",
    computerId: "computer-1",
    collectorAgentId: "agent-1",
    scanPaths: ["/work"],
    status: slotStatus,
    retryCount: 0,
    failureReason: null,
    packMarkdown: slotPack,
    requestId: slotRequestId,
  });

  const runRow = () => ({
    id: "run-1",
    reportId: "report-1",
    workspaceId: "ws-1",
    userId: "user-1",
    status: runStatus,
    windowKind: "week",
    windowStart: new Date("2026-08-31T00:00:00.000Z"),
    windowEnd: new Date("2026-09-07T00:00:00.000Z"),
    startedAt: new Date("2026-09-17T00:00:00.000Z"),
    completedAt: runCompletedAt,
    createdAt: new Date("2026-09-17T00:00:00.000Z"),
    slots: [slotRow()],
  });

  const db = {
    weeklyReportCollectSlot: {
      findFirst: async ({ where }: { where: { requestId?: string } }) => {
        if (where.requestId && where.requestId === slotRequestId) {
          return { ...slotRow(), run: runRow() };
        }
        return null;
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        slotStatus = String(data.status);
        slotPack = (data.packMarkdown as string | null) ?? null;
        slotRequestId = (data.requestId as string | null) ?? null;
        return slotRow();
      },
    },
    weeklyReportCollectRun: {
      findFirst: async () => runRow(),
      findFirstOrThrow: async () => runRow(),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status?: string };
        data: Record<string, unknown>;
      }) => {
        if (where.status !== undefined && where.status !== runStatus) {
          return { count: 0 };
        }
        runStatus = String(data.status);
        runCompletedAt = (data.completedAt as Date | null | undefined) ?? runCompletedAt;
        return { count: 1 };
      },
    },
  };

  const first = await acceptCollectSlotReport(db as never, {
    workspaceId: "ws-1",
    agentId: "agent-1",
    requestId: "11111111-1111-4111-8111-111111111111",
    runId: "run-1",
    outcome: "ready",
    packMarkdown: "# pack from ubuntu",
  });
  expect(first.newlyAccepted).toBe(true);
  expect(first.synthesisStarted).toBe(true);
  expect(first.run.status).toBe(COLLECT_RUN_STATUS.synthesizing);
  expect(first.run.canSynthesize).toBe(true);
  expect(runStatus).toBe(COLLECT_RUN_STATUS.synthesizing);

  const replay = await acceptCollectSlotReport(db as never, {
    workspaceId: "ws-1",
    agentId: "agent-1",
    requestId: "11111111-1111-4111-8111-111111111111",
    runId: "run-1",
    outcome: "ready",
    packMarkdown: "# pack from ubuntu",
  });
  expect(replay.newlyAccepted).toBe(false);
  expect(replay.synthesisStarted).toBe(false);
  expect(replay.run.status).toBe(COLLECT_RUN_STATUS.synthesizing);
});

test("acceptCollectSlotReport leaves collecting when every slot failed with no ready pack", async () => {
  // LLM/provider failures that surface via submit-failure must not leave the run
  // stuck on collecting — the side-chat card stops polling only after status changes.
  const { acceptCollectSlotReport, COLLECT_RUN_STATUS, COLLECT_SLOT_STATUS } =
    await import("@/server/records/weekly-report-collect-run.server");

  let slotStatus: string = COLLECT_SLOT_STATUS.running;
  let slotRequestId: string | null = null;
  let slotFailure: string | null = null;
  let runStatus: string = COLLECT_RUN_STATUS.collecting;
  let runCompletedAt: Date | null = null;

  const slotRow = () => ({
    id: "slot-1",
    computerId: "computer-1",
    collectorAgentId: "agent-1",
    scanPaths: ["/work"],
    status: slotStatus,
    retryCount: 0,
    failureReason: slotFailure,
    packMarkdown: null,
    requestId: slotRequestId,
  });

  const runRow = () => ({
    id: "run-1",
    reportId: "report-1",
    workspaceId: "ws-1",
    userId: "user-1",
    status: runStatus,
    windowKind: "week",
    windowStart: new Date("2026-08-31T00:00:00.000Z"),
    windowEnd: new Date("2026-09-07T00:00:00.000Z"),
    startedAt: new Date("2026-09-17T00:00:00.000Z"),
    completedAt: runCompletedAt,
    createdAt: new Date("2026-09-17T00:00:00.000Z"),
    slots: [slotRow()],
  });

  const db = {
    weeklyReportCollectSlot: {
      findFirst: async ({ where }: { where: { requestId?: string } }) => {
        if (where.requestId && where.requestId === slotRequestId) {
          return { ...slotRow(), run: runRow() };
        }
        return null;
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        slotStatus = String(data.status);
        slotFailure = (data.failureReason as string | null) ?? null;
        slotRequestId = (data.requestId as string | null) ?? null;
        return slotRow();
      },
    },
    weeklyReportCollectRun: {
      findFirst: async () => runRow(),
      findFirstOrThrow: async () => runRow(),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status?: string };
        data: Record<string, unknown>;
      }) => {
        if (where.status !== undefined && where.status !== runStatus) {
          return { count: 0 };
        }
        runStatus = String(data.status);
        runCompletedAt = (data.completedAt as Date | null | undefined) ?? runCompletedAt;
        return { count: 1 };
      },
    },
  };

  const result = await acceptCollectSlotReport(db as never, {
    workspaceId: "ws-1",
    agentId: "agent-1",
    requestId: "22222222-2222-4222-8222-222222222222",
    runId: "run-1",
    outcome: "failed",
    failureReason: "Error: 405 Not Allowed (nginx)",
  });

  expect(result.newlyAccepted).toBe(true);
  expect(result.synthesisStarted).toBe(false);
  expect(result.waveExhausted).toBe(true);
  expect(result.run.status).toBe(COLLECT_RUN_STATUS.cancelled);
  expect(result.run.allTerminal).toBe(true);
  expect(result.run.canSynthesize).toBe(false);
  expect(slotStatus).toBe(COLLECT_SLOT_STATUS.failed);
  expect(slotFailure ?? "").toContain("405");
  expect(runStatus).toBe(COLLECT_RUN_STATUS.cancelled);
  expect(runCompletedAt).toBeInstanceOf(Date);
});

test("settleStaleCollectRun marks overdue running slots stalled and closes an empty wave", async () => {
  const { settleStaleCollectRun, COLLECT_RUN_STATUS, COLLECT_SLOT_STATUS, COLLECT_SLOT_STALL_MS } =
    await import("@/server/records/weekly-report-collect-run.server");

  let slotStatus: string = COLLECT_SLOT_STATUS.running;
  let slotFailure: string | null = null;
  let runStatus: string = COLLECT_RUN_STATUS.collecting;
  let runCompletedAt: Date | null = null;
  const startedAt = new Date("2026-09-17T00:00:00.000Z");

  const slotRow = () => ({
    id: "slot-1",
    computerId: "computer-1",
    collectorAgentId: "agent-1",
    scanPaths: ["/work"],
    status: slotStatus,
    retryCount: 0,
    failureReason: slotFailure,
    packMarkdown: null,
    requestId: null,
  });

  const runRow = () => ({
    id: "run-1",
    reportId: "report-1",
    workspaceId: "ws-1",
    userId: "user-1",
    status: runStatus,
    windowKind: "week",
    windowStart: new Date("2026-08-31T00:00:00.000Z"),
    windowEnd: new Date("2026-09-07T00:00:00.000Z"),
    startedAt,
    completedAt: runCompletedAt,
    createdAt: startedAt,
    slots: [slotRow()],
  });

  const db = {
    weeklyReportCollectRun: {
      findFirst: async () => runRow(),
      findFirstOrThrow: async () => runRow(),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status?: string };
        data: Record<string, unknown>;
      }) => {
        if (where.status !== undefined && where.status !== runStatus) return { count: 0 };
        runStatus = String(data.status);
        runCompletedAt = (data.completedAt as Date | null | undefined) ?? runCompletedAt;
        return { count: 1 };
      },
    },
    weeklyReportCollectSlot: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { runId: string; status: string };
        data: Record<string, unknown>;
      }) => {
        expect(where.status).toBe(COLLECT_SLOT_STATUS.running);
        slotStatus = String(data.status);
        slotFailure = (data.failureReason as string | null) ?? null;
        return { count: 1 };
      },
    },
  };

  const now = startedAt.getTime() + COLLECT_SLOT_STALL_MS + 1;
  const view = await settleStaleCollectRun(
    db as never,
    { workspaceId: "ws-1", userId: "user-1", runId: "run-1" },
    now,
  );

  expect(slotStatus).toBe(COLLECT_SLOT_STATUS.stalled);
  expect(slotFailure).toMatch(/超时|模型|接口|上报/);
  expect(view.status).toBe(COLLECT_RUN_STATUS.cancelled);
  expect(view.allTerminal).toBe(true);
  expect(runCompletedAt).toBeInstanceOf(Date);
});
