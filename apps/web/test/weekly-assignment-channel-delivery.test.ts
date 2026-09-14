import { expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";
import { GeneralChannelWeeklyAssignmentDelivery } from "../src/server/records/weekly-assignment-channel-delivery.server";
import {
  buildWeeklyAssignmentChannelBody,
  weeklyAssignmentChannelRequestId,
} from "../src/server/records/weekly-assignment-channel-notify";

test("GeneralChannelWeeklyAssignmentDelivery posts one #general message", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const db = {
    conversation: {
      findFirst: async () => ({ id: "general-1" }),
    },
  } as unknown as PrismaClient;
  const channels = {
    send: async (input: Record<string, unknown>) => {
      sent.push(input);
      return {};
    },
  };

  await new GeneralChannelWeeklyAssignmentDelivery(db, channels as never).notifyChannel({
    workspaceId: "workspace-1",
    senderUserId: "leader",
    parentReportId: "parent-1",
    week: 38,
    senderDisplayName: "Boss",
  });

  expect(sent).toEqual([
    {
      workspaceId: "workspace-1",
      userId: "leader",
      channelId: "general-1",
      requestId: weeklyAssignmentChannelRequestId("parent-1"),
      body: buildWeeklyAssignmentChannelBody({
        senderDisplayName: "Boss",
        week: 38,
      }),
    },
  ]);
});

test("GeneralChannelWeeklyAssignmentDelivery no-ops when #general is missing", async () => {
  let sendCalls = 0;
  const db = {
    conversation: {
      findFirst: async () => null,
    },
  } as unknown as PrismaClient;
  const channels = {
    send: async () => {
      sendCalls += 1;
    },
  };

  await new GeneralChannelWeeklyAssignmentDelivery(db, channels as never).notifyChannel({
    workspaceId: "workspace-1",
    senderUserId: "leader",
    parentReportId: "parent-1",
    week: 38,
    senderDisplayName: "Boss",
  });

  expect(sendCalls).toBe(0);
});
