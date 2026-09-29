import { expect, test } from "bun:test";
import type { AgentMentionDelivery } from "@lrm/coforge-sdk/agent";
import { handleAgentMentionDeliveriesGet } from "#src/routes/api/agent/v1/messages_.$messageId.mention-deliveries";

const principal = { workspaceId: "workspace-1", agentId: "agent-1" };
const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";

test("answers each @mentioned Agent's outcome for a message the calling Agent sent", async () => {
  const calls: unknown[] = [];
  const deliveries: AgentMentionDelivery[] = [
    { targetHandle: "@bob", outcome: "lost", reasonCategory: "quota" },
    { targetHandle: "@carol", outcome: "pending" },
  ];
  const response = await handleAgentMentionDeliveriesGet(principal, "11111111", {
    mentionDeliveries: async (scope, messageId) => {
      calls.push({ scope, messageId });
      return { state: "found", messageId: MESSAGE_ID, deliveries };
    },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, messageId: MESSAGE_ID, deliveries });
  expect(calls).toEqual([{ scope: principal, messageId: "11111111" }]);
});

test("a message the calling Agent did not send is not found, like one that does not exist", async () => {
  const response = await handleAgentMentionDeliveriesGet(principal, MESSAGE_ID, {
    mentionDeliveries: async () => ({ state: "not_found" }),
  });
  expect(response.status).toBe(404);
  const body = (await response.json()) as { ok: boolean; errorCode: string; error: string };
  expect(body.ok).toBe(false);
  expect(body.errorCode).toBe("message_not_found");
  expect(body.error).toContain(MESSAGE_ID);
});

test("a prefix more than one sent message starts with asks for the full id", async () => {
  const response = await handleAgentMentionDeliveriesGet(principal, "11111111", {
    mentionDeliveries: async () => ({ state: "ambiguous" }),
  });
  expect(response.status).toBe(400);
  expect(((await response.json()) as { errorCode: string }).errorCode).toBe("ambiguous_message_id");
});
