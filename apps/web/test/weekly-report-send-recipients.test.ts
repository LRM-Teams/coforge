import { expect, test } from "bun:test";

import { recipientUserIdsForSend } from "#src/server/records/weekly-report-send-recipients.server";

test("allMembers send includes every workspace member during testing", () => {
  expect(
    recipientUserIdsForSend({
      allMembers: true,
      recipientUserIds: [],
      workspaceMemberIds: ["leader", "a", "b"],
      senderUserId: "leader",
    }),
  ).toEqual(["leader", "a", "b"]);
});

test("explicit recipients keep the sender when listed", () => {
  expect(
    recipientUserIdsForSend({
      allMembers: false,
      recipientUserIds: ["a", "leader", "a"],
      workspaceMemberIds: ["leader", "a", "b"],
      senderUserId: "leader",
    }),
  ).toEqual(["a", "leader"]);
});

test("self-only recipient list sends to the sender", () => {
  expect(
    recipientUserIdsForSend({
      allMembers: false,
      recipientUserIds: ["leader"],
      workspaceMemberIds: ["leader"],
      senderUserId: "leader",
    }),
  ).toEqual(["leader"]);
});

test("empty recipient configuration yields no recipients", () => {
  expect(
    recipientUserIdsForSend({
      allMembers: false,
      recipientUserIds: [],
      workspaceMemberIds: ["leader", "a"],
      senderUserId: "leader",
    }),
  ).toEqual([]);
});
