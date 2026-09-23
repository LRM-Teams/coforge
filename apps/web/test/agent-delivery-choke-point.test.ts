import { expect, test } from "bun:test";
import { Glob } from "bun";

import { encodeAgentDelivery } from "#src/server/conversations/agent-delivery.server";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";

const CHANNEL_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

test("every Agent delivery is encoded through the one function that makes its body readable", async () => {
  const callers: string[] = [];
  for await (const path of new Glob("src/**/*.ts").scan({ cwd: import.meta.dir + "/.." })) {
    const source = await Bun.file(`${import.meta.dir}/../${path}`).text();
    if (source.includes("encodeAgentMessageDelivery(")) callers.push(path);
  }
  expect(callers).toEqual(["src/server/conversations/agent-delivery.server.ts"]);
});

test("a delivery's body never carries a stored token", () => {
  const payload = encodeAgentDelivery({
    requestId: "request-1",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    conversationId: "44444444-4444-4444-8444-444444444444",
    agentId: AGENT_ID,
    messageId: "55555555-5555-4555-8555-555555555555",
    deliveryId: "66666666-6666-4666-8666-666666666666",
    sequence: 1,
    target: "#general",
    latestSenderKind: "human",
    latestSenderHandle: "ada",
    latestSenderDescription: "",
    body: `<@agent:${AGENT_ID}> see <@task:7> in <@channel:${CHANNEL_ID}:product>`,
    mentions: [{ kind: "agent", actorId: AGENT_ID, handle: "helper" }],
  });
  expect(decodeAgentMessageDelivery(payload).body).toBe("@helper see task #7 in #product");
});
