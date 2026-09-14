import { expect, test } from "bun:test";
import {
  buildWeeklyAssignmentChannelBody,
  weeklyAssignmentChannelRequestId,
} from "../src/server/records/weekly-assignment-channel-notify";

test("buildWeeklyAssignmentChannelBody names the sender and week", () => {
  expect(
    buildWeeklyAssignmentChannelBody({
      senderDisplayName: "张三",
      week: 38,
    }),
  ).toBe("张三 已布置 W38 周报，请到「我的周报」填写。");
});

test("weeklyAssignmentChannelRequestId is a stable UUID for the same parent", () => {
  const parentId = "11111111-2222-4333-8444-555555555555";
  const first = weeklyAssignmentChannelRequestId(parentId);
  const second = weeklyAssignmentChannelRequestId(parentId);
  expect(first).toBe(second);
  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(weeklyAssignmentChannelRequestId("99999999-2222-4333-8444-555555555555")).not.toBe(first);
});
