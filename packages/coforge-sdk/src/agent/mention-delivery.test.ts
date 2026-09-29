import { expect, test } from "bun:test";
import {
  decodeAgentMentionDeliveryErrorResponse,
  decodeAgentMentionDeliveryResponse,
  type AgentMentionDeliveryResponse,
} from "./mention-delivery";
import { decodeAgentMentionActionErrorResponse } from "./mention-actions";

const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";

const DELIVERIES: AgentMentionDeliveryResponse = {
  ok: true,
  messageId: MESSAGE_ID,
  deliveries: [
    { targetHandle: "@bob", outcome: "lost", reasonCategory: "quota" },
    { targetHandle: "@carol", outcome: "pending" },
    { targetHandle: "@dave", outcome: "delivered" },
    { targetHandle: "@erin", targetDeleted: true, outcome: "lost", reasonCategory: "not_launched" },
    { targetHandle: "@fay", outcome: "unknown" },
  ],
};

test("decodes each target's outcome for a message the Agent sent", () => {
  expect(decodeAgentMentionDeliveryResponse(DELIVERIES)).toEqual(DELIVERIES);
  expect(
    decodeAgentMentionDeliveryResponse({ ok: true, messageId: MESSAGE_ID, deliveries: [] }),
  ).toEqual({ ok: true, messageId: MESSAGE_ID, deliveries: [] });
});

test("a lost target must say why, and only a lost target may", () => {
  const decode = (row: unknown) =>
    decodeAgentMentionDeliveryResponse({ ok: true, messageId: MESSAGE_ID, deliveries: [row] });
  expect(() => decode({ targetHandle: "@bob", outcome: "lost" })).toThrow(
    "invalid Agent mention delivery response",
  );
  expect(() => decode({ targetHandle: "@bob", outcome: "lost", reasonCategory: "busy" })).toThrow();
  expect(() =>
    decode({ targetHandle: "@bob", outcome: "pending", reasonCategory: "quota" }),
  ).toThrow();
  expect(() => decode({ targetHandle: "@bob", outcome: "arrived" })).toThrow();
  expect(() => decode({ targetHandle: "bob", outcome: "delivered" })).toThrow();
  expect(() =>
    decode({ targetHandle: "@bob", targetDeleted: false, outcome: "pending" }),
  ).toThrow();
  expect(() => decode({ outcome: "delivered" })).toThrow();
  expect(() => decodeAgentMentionDeliveryResponse({ ok: true, deliveries: [] })).toThrow();
});

test("the lookup has its own error codes, apart from the mention actions'", () => {
  const notFound = {
    ok: false,
    errorCode: "message_not_found",
    error: "You sent no message with that id.",
  } as const;
  expect(decodeAgentMentionDeliveryErrorResponse(notFound)).toEqual(notFound);
  expect(decodeAgentMentionActionErrorResponse(notFound)).toBeUndefined();
  expect(
    decodeAgentMentionDeliveryErrorResponse({
      ok: false,
      errorCode: "invalid_request",
      error: "x",
    }),
  ).toBeUndefined();
});
