import { expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";
import {
  applyPersonalKeyPointExtraction,
  buildPersonalKeyPointWakeText,
  isWeeklyReportAssistantReady,
  mergeKeyPointPromptSlot,
  startPersonalKeyPointExtraction,
} from "../src/server/records/weekly-report-key-points.server";
import { emptyKeyPointPrompts } from "../src/features/records/records-content";
import { AppError } from "../src/lib/app-error";

test("isWeeklyReportAssistantReady requires a Computer and CoForge apiKey when runtime is coforge", () => {
  expect(
    isWeeklyReportAssistantReady({
      computerId: null,
      runtimeConfig: {
        runtime: "codex",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    }),
  ).toBe(false);
  expect(
    isWeeklyReportAssistantReady({
      computerId: "c1",
      runtimeConfig: {
        runtime: "codex",
        provider: { kind: "default" },
        model: "gpt",
        modelProvider: "",
        reasoning: "",
      },
    }),
  ).toBe(true);
  expect(
    isWeeklyReportAssistantReady({
      computerId: "c1",
      runtimeConfig: {
        runtime: "coforge",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    }),
  ).toBe(false);
});

test("buildPersonalKeyPointWakeText embeds report id and prompt for the assistant", () => {
  const body = buildPersonalKeyPointWakeText({
    reportId: "11111111-1111-4111-8111-111111111111",
    prompt: "提炼本周进展",
    authorDisplayName: "李健",
    year: 2026,
    week: 35,
  });
  expect(body).toContain("[weekly-report-key-points]");
  expect(body).toContain("11111111-1111-4111-8111-111111111111");
  expect(body).toContain("提炼本周进展");
  expect(body).toContain("submit");
});

test("mergeKeyPointPromptSlot updates one slot and keeps the other", () => {
  const base = emptyKeyPointPrompts();
  const next = mergeKeyPointPromptSlot(base, "personal", "new personal", new Date("2026-09-18T00:00:00Z"));
  expect(next.personal.text).toBe("new personal");
  expect(next.team.text).toBe(base.team.text);
});

test("startPersonalKeyPointExtraction is idempotent when already generating", async () => {
  const wakes: unknown[] = [];
  const db = {
    weeklyReport: {
      findFirst: async () => ({
        id: "report-1",
        content: {
          tabs: { Summary: { markdown: "x" } },
          keyPointExtraction: {
            status: "generating",
            promptSnapshot: "p",
          },
        },
        status: "submitted",
        authorId: "member-1",
        sourceTemplateId: "tpl-1",
        author: { username: "m", displayName: "Member" },
        cycle: { year: 2026, week: 35 },
        sourceTemplate: { authorId: "leader-1", settingsId: "settings-1" },
      }),
      update: async () => {
        throw new Error("should not update");
      },
    },
  } as unknown as PrismaClient;

  const result = await startPersonalKeyPointExtraction(db, {
    workspaceId: "ws-1",
    memberReportId: "report-1",
    wake: async (args) => {
      wakes.push(args);
    },
  });
  expect(result).toEqual({ started: false, status: "generating" });
  expect(wakes).toEqual([]);
});

test("startPersonalKeyPointExtraction marks pending_setup when Leader assistant is not ready", async () => {
  let written: unknown;
  const db = {
    weeklyReport: {
      findFirst: async (query: { where?: { settingsId?: string; kind?: string } }) => {
        if (query.where?.settingsId) {
          return {
            content: { tabs: { Summary: { markdown: "" } }, keyPointPrompts: emptyKeyPointPrompts() },
          };
        }
        return {
          id: "report-1",
          content: { tabs: { Summary: { markdown: "body" } } },
          status: "submitted",
          authorId: "member-1",
          sourceTemplateId: "tpl-1",
          author: { username: "m", displayName: "Member" },
          cycle: { year: 2026, week: 35 },
          sourceTemplate: { authorId: "leader-1", settingsId: "settings-1" },
        };
      },
      update: async (args: { data: { content: unknown } }) => {
        written = args.data.content;
        return {};
      },
    },
    weeklyReportAssistant: {
      findUnique: async () => ({
        id: "asst-1",
        agentId: "agent-1",
        workspaceId: "ws-1",
        userId: "leader-1",
      }),
    },
    agent: {
      findUnique: async () => ({ computerId: null, runtimeConfig: { runtime: "coforge", provider: { kind: "default" }, model: "", modelProvider: "", reasoning: "" } }),
      create: async () => ({ id: "agent-1" }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        weeklyReportAssistant: {
          findUnique: async () => ({
            id: "asst-1",
            agentId: "agent-1",
            workspaceId: "ws-1",
            userId: "leader-1",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
      }),
  } as unknown as PrismaClient;

  const result = await startPersonalKeyPointExtraction(db, {
    workspaceId: "ws-1",
    memberReportId: "report-1",
    wake: async () => {
      throw new Error("should not wake");
    },
  });
  expect(result.status).toBe("pending_setup");
  expect(written).toMatchObject({
    keyPointExtraction: { status: "pending_setup" },
  });
});

test("applyPersonalKeyPointExtraction writes ready markdown for the Leader assistant only", async () => {
  let written: unknown;
  const db = {
    weeklyReportAssistant: {
      findFirst: async () => ({ userId: "leader-1" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "report-1",
        content: {
          tabs: { Summary: { markdown: "x" } },
          keyPointExtraction: { status: "generating", promptSnapshot: "prompt" },
        },
        sourceTemplate: { authorId: "leader-1" },
      }),
      update: async (args: { data: { content: unknown } }) => {
        written = args.data.content;
        return {};
      },
    },
  } as unknown as PrismaClient;

  const result = await applyPersonalKeyPointExtraction(db, {
    workspaceId: "ws-1",
    agentId: "agent-1",
    reportId: "report-1",
    markdown: "## Current Work\n\n- done",
    requestId: "11111111-1111-4111-8111-111111111111",
  });
  expect(result).toEqual({ status: "ready", reportId: "report-1" });
  expect(written).toMatchObject({
    keyPointExtraction: {
      status: "ready",
      markdown: "## Current Work\n\n- done",
      promptSnapshot: "prompt",
    },
  });
});

test("startPersonalKeyPointExtraction force=true re-runs when already ready", async () => {
  const wakes: unknown[] = [];
  let written: unknown;
  const db = {
    weeklyReport: {
      findFirst: async (query: { where?: { kind?: string; settingsId?: string | null } }) => {
        if (query.where?.kind === "template" || query.where?.settingsId) {
          return {
            id: "format-1",
            content: {
              tabs: { Summary: { markdown: "" } },
              keyPointPrompts: emptyKeyPointPrompts(),
            },
          };
        }
        return {
          id: "report-1",
          content: {
            tabs: { Summary: { markdown: "x" } },
            keyPointExtraction: {
              status: "ready",
              promptSnapshot: "old",
              markdown: "- done",
            },
          },
          status: "submitted",
          authorId: "member-1",
          sourceTemplateId: "format-1",
          author: { username: "m", displayName: "成员" },
          cycle: { year: 2026, week: 38 },
          sourceTemplate: { authorId: "leader-1", settingsId: "settings-1" },
        };
      },
      update: async (args: { data: { content: unknown } }) => {
        written = args.data.content;
        return {};
      },
    },
    weeklyReportAssistant: {
      findUnique: async () => ({
        id: "asst-1",
        agentId: "agent-1",
        workspaceId: "ws-1",
        userId: "leader-1",
      }),
    },
    agent: {
      findUnique: async () => ({
        computerId: "c1",
        runtimeConfig: {
          runtime: "codex",
          provider: { kind: "default" },
          model: "gpt",
          modelProvider: "",
          reasoning: "",
        },
      }),
      create: async () => ({ id: "agent-1" }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        weeklyReportAssistant: {
          findUnique: async () => ({
            id: "asst-1",
            agentId: "agent-1",
            workspaceId: "ws-1",
            userId: "leader-1",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
      }),
  } as unknown as PrismaClient;

  // ensureWeeklyReportAssistantChatSession needs more mocks — use pending_setup path instead by null computer after force clears ready
  const pendingDb = {
    ...db,
    agent: {
      findUnique: async () => ({
        computerId: null,
        runtimeConfig: {
          runtime: "coforge",
          provider: { kind: "default" },
          model: "",
          modelProvider: "",
          reasoning: "",
        },
      }),
      create: async () => ({ id: "agent-1" }),
    },
  } as unknown as PrismaClient;

  const result = await startPersonalKeyPointExtraction(pendingDb, {
    workspaceId: "ws-1",
    memberReportId: "report-1",
    force: true,
    wake: async (args) => {
      wakes.push(args);
    },
  });
  expect(result.status).toBe("pending_setup");
  expect(written).toMatchObject({
    keyPointExtraction: { status: "pending_setup" },
  });
  expect(wakes).toHaveLength(0);
});

test("applyPersonalKeyPointExtraction denies a non-owner assistant", async () => {
  const db = {
    weeklyReportAssistant: {
      findFirst: async () => ({ userId: "other-leader" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "report-1",
        content: { tabs: { Summary: { markdown: "x" } } },
        sourceTemplate: { authorId: "leader-1" },
      }),
    },
  } as unknown as PrismaClient;

  await expect(
    applyPersonalKeyPointExtraction(db, {
      workspaceId: "ws-1",
      agentId: "agent-1",
      reportId: "report-1",
      markdown: "x",
      requestId: "11111111-1111-4111-8111-111111111111",
    }),
  ).rejects.toEqual(new AppError("ACCESS_DENIED"));
});
