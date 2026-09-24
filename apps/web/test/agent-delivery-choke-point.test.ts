import { expect, test } from "bun:test";
import { Glob } from "bun";

import { encodeAgentDelivery } from "#src/server/conversations/agent-delivery.server";
import {
  agentMessageView,
  type AgentReadableBody,
} from "#src/server/conversations/agent-message-view.server";
import type { AgentMessageRepository } from "#src/server/agents/agent-messages.server";
import type { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";

const CHANNEL_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const TOKENIZED = `<@agent:${AGENT_ID}> see <@task:7> in <@channel:${CHANNEL_ID}:product>`;
const MENTIONS = [{ kind: "agent", actorId: AGENT_ID, handle: "helper" }];

/** The `src/` files whose source contains `needle`, relative to `apps/web`. */
async function filesContaining(needle: string) {
  const files: string[] = [];
  for await (const path of new Glob("src/**/*.{ts,tsx}").scan({ cwd: import.meta.dir + "/.." })) {
    const source = await Bun.file(`${import.meta.dir}/../${path}`).text();
    if (source.includes(needle)) files.push(path);
  }
  return files.sort();
}

test("every Agent delivery is encoded through the one function that makes its body readable", async () => {
  expect(await filesContaining("encodeAgentMessageDelivery(")).toEqual([
    "src/server/conversations/agent-delivery.server.ts",
  ]);
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
    body: TOKENIZED,
    mentions: MENTIONS,
  });
  expect(decodeAgentMessageDelivery(payload).body).toBe("@helper see task #7 in #product");
});

/**
 * Agent-facing message records are built only by `agentMessageView`: no serializer reads a stored
 * body back itself. The daemon encoder, a Task's title (`view`, `quotedTask`) and the push preview
 * are the other readers of stored bodies, each at its single call site.
 */
test("no Agent-facing serializer reads a stored body except through agentMessageView", async () => {
  const callers = (await filesContaining("agentReadableBody(")).filter(
    (path) => path !== "src/server/conversations/mentions.server.ts",
  );
  expect(callers).toEqual([
    "src/server/conversations/agent-delivery.server.ts",
    "src/server/conversations/agent-message-view.server.ts",
    "src/server/notifications/prisma-web-push-subscriptions.server.ts",
    "src/server/tasks/task-board.server.ts",
    "src/server/tasks/task-notices.server.ts",
  ]);
  // Only the projection mints the readable-body type.
  expect(await filesContaining("as AgentReadableBody")).toEqual([
    "src/server/conversations/agent-message-view.server.ts",
  ]);
});

test("the Agent projection reads every stored token back as text, and says when it mentions the reader", () => {
  // Compared as the plain strings they are at runtime.
  const view = (...args: Parameters<typeof agentMessageView>) => {
    const { body, ...rest } = agentMessageView(...args);
    return { body: body as string, ...rest };
  };
  expect(view({ body: TOKENIZED, mentions: MENTIONS })).toEqual({
    body: "@helper see task #7 in #product",
  });
  expect(view({ body: TOKENIZED, mentions: MENTIONS }, AGENT_ID)).toEqual({
    body: "@helper see task #7 in #product",
    mentionsAgent: true,
  });
  expect(view({ body: TOKENIZED, mentions: MENTIONS }, "someone-else")).toEqual({
    body: "@helper see task #7 in #product",
  });
  expect(view({ body: "create it", mentions: [], actionCard: { state: "pending" } })).toEqual({
    body: "create it [action card: pending]",
  });
});

/*
 * Checked by the type checker (`bun run check` covers `test/`): every Agent-facing read of the
 * repository, the Agent HTTP port's and the daemon recovery's alike, returns bodies typed
 * `AgentReadableBody`, which only `agentMessageView` produces. A serializer that ships a stored
 * body, overrides the projected body after the spread, or edits it, has a plain `string` there,
 * and `UnprojectedRead` names its method. See `AgentReadableBody` for what this cannot catch.
 */
type Repository = PrismaDirectConversationRepository;
type AgentFacingRead =
  | Extract<keyof AgentMessageRepository, keyof Repository>
  | "readAgentRecoveryContext"
  | "readPendingAgentDeliveries";
type MessageOf<T> = T extends { messages: readonly (infer M)[] }
  ? M
  : T extends { resumeMessages: readonly (infer M)[] }
    ? M
    : T extends readonly (infer M)[]
      ? M
      : T;
type UnprojectedRead = {
  [K in AgentFacingRead]: MessageOf<Awaited<ReturnType<Repository[K]>>> extends {
    body: infer Body;
  }
    ? [Body] extends [AgentReadableBody]
      ? never
      : K
    : never;
}[AgentFacingRead];
type ExpectNone<T extends never> = T;
export type EveryAgentReadIsProjected = ExpectNone<UnprojectedRead>;
