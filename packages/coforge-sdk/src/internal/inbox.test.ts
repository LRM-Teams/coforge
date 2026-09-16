import { expect, test } from "bun:test";
import {
  decodeInboxResponse,
  decodeLocalInboxRequest,
  encodeInboxResponse,
  encodeLocalInboxRequest,
} from "./index";

test("round trips the version-compatible unified Inbox protocol", () => {
  expect(
    decodeLocalInboxRequest(
      encodeLocalInboxRequest({ requestId: "r", context: "c", operation: "check" }),
    ),
  ).toEqual({ requestId: "r", context: "c", operation: "check" });
  const response = {
    requestId: "r",
    accepted: true,
    entries: [
      {
        kind: "app" as const,
        app: {
          itemId: "reminder:id:1",
          appId: "system.reminder",
          notificationClass: "due",
          sourceRef: { kind: "reminder", id: "id", revision: "1" },
          title: "Due",
          summary: "Now",
          retention: "until_explicit_ack" as const,
          action: { kind: "run_command" as const, commandId: "reminder.ack" },
          createdAt: "2026-09-03T00:00:00.000Z",
        },
      },
    ],
  };
  expect(decodeInboxResponse(encodeInboxResponse(response))).toEqual(response);
});
