import { expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";
import { RecordCatalog } from "../src/server/records/record-catalog.server";
import {
  looksLikeMemberGenerateOfferAccept,
  parseRecordAssistantPayload,
} from "../src/features/records/weekly-highlight-extract";

test("looksLikeMemberGenerateOfferAccept matches E1 intent", () => {
  expect(looksLikeMemberGenerateOfferAccept("需要")).toBe(true);
  expect(looksLikeMemberGenerateOfferAccept("帮我生成")).toBe(true);
  expect(looksLikeMemberGenerateOfferAccept("随便聊聊")).toBe(false);
});

test("looksLikeCollectAgainRequest and synthesize intents match product phrases", async () => {
  const {
    looksLikeCollectAgainRequest,
    looksLikeSynthesizeWeeklyReportRequest,
    looksLikeMemberReportRuleIntent,
  } = await import("../src/features/records/weekly-highlight-extract");
  expect(looksLikeCollectAgainRequest("再采集一遍")).toBe(true);
  expect(looksLikeCollectAgainRequest("重新采集")).toBe(true);
  expect(looksLikeCollectAgainRequest("随便聊聊")).toBe(false);
  expect(looksLikeSynthesizeWeeklyReportRequest("整理周报")).toBe(true);
  expect(looksLikeSynthesizeWeeklyReportRequest("根据采集包总结一下")).toBe(true);
  expect(looksLikeSynthesizeWeeklyReportRequest("天气怎么样")).toBe(false);
  expect(looksLikeMemberReportRuleIntent("再采集一遍")).toBe(true);
  expect(looksLikeMemberReportRuleIntent("整理周报")).toBe(true);
  expect(looksLikeMemberReportRuleIntent("需要")).toBe(true);
});

test("parseRecordAssistantPayload accepts confirm-intent and intent-declined", () => {
  expect(
    parseRecordAssistantPayload({
      kind: "confirm-intent",
      intent: "collect-again",
      reportId: "11111111-1111-1111-1111-111111111111",
      year: 2026,
      week: 38,
    }),
  ).toEqual({
    kind: "confirm-intent",
    intent: "collect-again",
    reportId: "11111111-1111-1111-1111-111111111111",
    year: 2026,
    week: 38,
  });
  expect(
    parseRecordAssistantPayload({
      kind: "confirm-intent",
      intent: "synthesize",
      reportId: "11111111-1111-1111-1111-111111111111",
      year: 2026,
      week: 38,
      userGuidance: "太细碎了，更概括一些，重新整理周报",
    }),
  ).toEqual({
    kind: "confirm-intent",
    intent: "synthesize",
    reportId: "11111111-1111-1111-1111-111111111111",
    year: 2026,
    week: 38,
    userGuidance: "太细碎了，更概括一些，重新整理周报",
  });
  expect(parseRecordAssistantPayload({ kind: "intent-declined" })).toEqual({
    kind: "intent-declined",
  });
});

test("declineMemberReportIntent recovers original text and continues instead of cancelling", async () => {
  const reportId = "11111111-1111-1111-1111-111111111111";
  const sessionId = "22222222-2222-2222-2222-222222222222";
  const created: Array<{ body: string; payload: unknown; authorType: string }> = [];
  let findManyCalls = 0;

  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: reportId,
        cycle: { year: 2026, week: 38 },
      }),
    },
    recordComment: {
      findMany: async () => {
        findManyCalls += 1;
        // 1st: latestConfirmIntentOriginalText (desc)
        if (findManyCalls === 1) {
          return [
            {
              authorType: "assistant",
              body: "要根据已有采集包整理一份周报草稿吗？",
              payload: {
                kind: "confirm-intent",
                intent: "synthesize",
                reportId,
                year: 2026,
                week: 38,
                userGuidance: "刚才整理的周报太细碎了，天气怎么样",
              },
            },
            {
              authorType: "user",
              body: "刚才整理的周报太细碎了，天气怎么样",
              payload: null,
            },
          ];
        }
        // 2nd: listComments (asc)
        return created.map((row, index) => ({
          id: `c${index}`,
          authorType: row.authorType,
          body: row.body,
          payload: row.payload,
          createdAt: new Date(`2026-09-18T08:0${index}:00.000Z`),
          authorUser: null,
        }));
      },
      create: async ({
        data,
      }: {
        data: { body: string; payload?: unknown; authorType: string };
      }) => {
        created.push({
          body: data.body,
          payload: data.payload ?? null,
          authorType: data.authorType,
        });
        return {
          id: `c${created.length}`,
          authorType: data.authorType,
          body: data.body,
          payload: data.payload ?? null,
          createdAt: new Date(),
          authorUser: null,
        };
      },
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).declineMemberReportIntent({
    workspaceId: "ws-1",
    userId: "user-1",
    reportId,
    assistantSessionId: sessionId,
  });

  expect(result.originalUserText).toBe("刚才整理的周报太细碎了，天气怎么样");
  expect(created.some((row) => row.body === "不是")).toBe(true);
  const declined = created.find((row) => row.authorType === "assistant");
  expect(declined?.body).toBe("好的，我按你刚才的问题继续回答。");
  expect(declined?.payload).toEqual({ kind: "intent-declined" });
  expect(result.comments.length).toBeGreaterThan(0);
});

test("parseRecordAssistantPayload accepts offer-help-generate", () => {
  expect(parseRecordAssistantPayload({ kind: "offer-help-generate" })).toEqual({
    kind: "offer-help-generate",
  });
});

test("ensureAssistantIntro posts assignee welcome with 需要 offer", async () => {
  const created: Array<{ body: string; payload: unknown }> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    recordComment: {
      findMany: async () => [],
      create: async ({
        data,
      }: {
        data: { body: string; payload?: unknown; authorType: string };
      }) => {
        created.push({ body: data.body, payload: data.payload ?? null });
        return {
          id: "c1",
          authorType: data.authorType,
          body: data.body,
          payload: data.payload ?? null,
          createdAt: new Date("2026-09-17T08:00:00.000Z"),
          authorUser: null,
        };
      },
    },
    weeklyReport: {
      findFirst: async () => ({
        cycle: { year: 2026, week: 36 },
        author: { displayName: "胡静", username: "hujing" },
      }),
    },
  } as unknown as PrismaClient;

  // Second listComments after write — return the created row.
  let listed = 0;
  (db as { recordComment: { findMany: () => Promise<unknown[]> } }).recordComment.findMany =
    async () => {
      listed += 1;
      if (listed === 1) return [];
      return [
        {
          id: "c1",
          authorType: "assistant",
          body: created[0]!.body,
          payload: created[0]!.payload,
          createdAt: new Date("2026-09-17T08:00:00.000Z"),
          authorUser: null,
        },
      ];
    };

  const rows = await new RecordCatalog(db).ensureAssistantIntro({
    workspaceId: "ws-1",
    userId: "user-1",
    subjectType: "report",
    subjectId: "11111111-1111-1111-1111-111111111111",
    assistantSessionId: "session-1",
    surface: "member-assignee",
  });

  expect(created).toHaveLength(1);
  expect(created[0]!.body).toContain("胡静");
  expect(created[0]!.body).toContain("2026 W36");
  expect(created[0]!.body).toContain("是否需要我来帮你直接生成");
  expect(created[0]!.payload).toEqual({ kind: "offer-help-generate" });
  expect(rows).toHaveLength(1);
});
