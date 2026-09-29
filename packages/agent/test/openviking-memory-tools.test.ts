import { expect, test } from "bun:test";
import {
  OPENVIKING_AGENT_PROTOCOL,
  OPENVIKING_TOOL_NAMES,
  OPENVIKING_TOOL_PROFILE,
  agentApiRoutes,
} from "@lrm/coforge-sdk/agent";
import {
  MemoryAgentTurnBudget,
  createMemoryFenceTools,
  resourceLoaderOptionsForSession,
  type MemoryAgentProxy,
} from "../src/runner";

const MUTATION_TOOL_NAMES = [
  "bash",
  "shell",
  "write",
  "edit",
  "apply_patch",
  "filesystem",
  "network",
];

const CHANNEL_MESSAGE_TOOLS = ["message_check", "message_read", "send_channel_message"] as const;

function emptyItemsResponse(protocol: string, op: string, operationId: string) {
  return { protocol, op, operationId, duplicate: false, items: [] };
}

function fakeProxy(
  handler?: (path: string, body: unknown) => unknown,
): MemoryAgentProxy & { calls: Array<{ path: string; body: unknown }> } {
  const calls: Array<{ path: string; body: unknown }> = [];
  return {
    calls,
    async post(path, body) {
      calls.push({ path, body });
      if (handler) return handler(path, body);
      const command = body as { protocol?: string; op?: string; operationId?: string };
      return emptyItemsResponse(
        command.protocol ?? "",
        command.op ?? "",
        command.operationId ?? "ok-1",
      );
    },
  };
}

async function executeTool(
  tools: ReturnType<typeof createMemoryFenceTools>,
  name: string,
  params: Record<string, unknown>,
) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.execute(name, params, undefined, undefined, undefined as never);
}

test("Memory Agent sessions disable Pi skill, context, and extension injection", () => {
  expect(resourceLoaderOptionsForSession({ instructions: "stand", memoryFence: false })).toEqual({
    systemPromptOverride: expect.any(Function),
  });
  expect(resourceLoaderOptionsForSession({ instructions: "stand", memoryFence: true })).toEqual({
    systemPromptOverride: expect.any(Function),
    noSkills: true,
    noContextFiles: true,
    noExtensions: true,
  });
  expect(
    resourceLoaderOptionsForSession({ instructions: "stand", disableHostPiInjection: true }),
  ).toEqual({
    systemPromptOverride: expect.any(Function),
    noSkills: true,
    noContextFiles: true,
    noExtensions: true,
  });
});

test("the openviking-memory fence exposes only ov_* reads, one offer, and channel message tools", () => {
  const names = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, new MemoryAgentTurnBudget()).map(
    (tool) => tool.name,
  );
  expect(names).toEqual([
    OPENVIKING_TOOL_NAMES.find,
    OPENVIKING_TOOL_NAMES.searchContext,
    OPENVIKING_TOOL_NAMES.read,
    OPENVIKING_TOOL_NAMES.offer,
    ...CHANNEL_MESSAGE_TOOLS,
  ]);
  expect(names.some((name) => name.startsWith("causal_"))).toBe(false);
  expect(MUTATION_TOOL_NAMES.some((name) => names.includes(name))).toBe(false);
});

test("a fourth memory read is rejected", () => {
  const budget = new MemoryAgentTurnBudget();
  const find = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "find" as const,
    operationId: "f1",
    query: "deploy",
  };
  budget.consume(find);
  budget.consume({ ...find, operationId: "f2" });
  budget.consume({ ...find, operationId: "f3" });
  expect(() => budget.consume({ ...find, operationId: "f4" })).toThrow("read budget");
});

test("a second Memory Offer is rejected", () => {
  const budget = new MemoryAgentTurnBudget();
  const offer = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "offer" as const,
    operationId: "o1",
    conversationId: "c",
    targetAgentId: "a",
    recipientRationale: "owns the task",
    citationRefs: ["ov:wiki/deploy"],
    body: "cited offer",
  };
  budget.consume(offer);
  expect(() => budget.consume({ ...offer, operationId: "o2" })).toThrow("offer budget");
});

test("the factory rejects a candidate limit above ten before calling the proxy", async () => {
  const proxy = fakeProxy();
  const tools = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, new MemoryAgentTurnBudget(), proxy);
  await expect(
    executeTool(tools, OPENVIKING_TOOL_NAMES.find, {
      operationId: "too-many",
      query: "deploy",
      limit: 11,
    }),
  ).rejects.toThrow("invalid openviking find limit");
  expect(proxy.calls).toEqual([]);
});

test("reset restores reads and offers for the next triggering message", () => {
  const budget = new MemoryAgentTurnBudget();
  const find = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "find" as const,
    operationId: "f1",
    query: "deploy",
  };
  const offer = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "offer" as const,
    operationId: "o1",
    conversationId: "c",
    targetAgentId: "a",
    recipientRationale: "owns the task",
    citationRefs: ["ov:wiki/deploy"],
    body: "cited offer",
  };
  budget.consume(find);
  budget.consume(offer);
  expect(budget.snapshot()).toEqual({ reads: 1, offers: 1 });
  budget.reset();
  expect(budget.snapshot()).toEqual({ reads: 0, offers: 0 });
  budget.consume({ ...find, operationId: "f2" });
  budget.consume({ ...offer, operationId: "o2" });
});

test("ov_* tools post the frozen openviking proxy path and never a mutation verb", async () => {
  const proxy = fakeProxy();
  const tools = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, new MemoryAgentTurnBudget(), proxy);
  await executeTool(tools, OPENVIKING_TOOL_NAMES.find, {
    operationId: "find-1",
    query: "deploy rollback",
    limit: 10,
  });
  expect(proxy.calls).toEqual([
    {
      path: agentApiRoutes.proxy.openviking.path,
      body: {
        protocol: OPENVIKING_AGENT_PROTOCOL,
        op: "find",
        operationId: "find-1",
        query: "deploy rollback",
        limit: 10,
      },
    },
  ]);
  expect(JSON.stringify(proxy.calls[0]?.body)).not.toContain("write");
  expect(JSON.stringify(proxy.calls[0]?.body)).not.toContain("commit");
});

test("openviking-memory search_context keeps the 3-read cap", () => {
  const budget = new MemoryAgentTurnBudget();
  const searchContext = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "search_context" as const,
    operationId: "c1",
    query: "deploy",
    tokenBudget: 8000,
  };
  budget.consume(searchContext);
  expect(budget.snapshot()).toEqual({ reads: 1, offers: 0 });
  budget.consume({ ...searchContext, operationId: "c2" });
  budget.consume({ ...searchContext, operationId: "c3" });
  expect(() => budget.consume({ ...searchContext, operationId: "c4" })).toThrow("read budget");
});

test("openviking-memory ov_search_context forwards the native tokenBudget unchanged", async () => {
  const proxy = fakeProxy();
  const tools = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, new MemoryAgentTurnBudget(), proxy);
  await executeTool(tools, OPENVIKING_TOOL_NAMES.searchContext, {
    operationId: "ctx-1",
    query: "deploy",
    tokenBudget: 8000,
  });
  expect(proxy.calls[0]).toEqual({
    path: agentApiRoutes.proxy.openviking.path,
    body: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "search_context",
      operationId: "ctx-1",
      query: "deploy",
      tokenBudget: 8000,
    },
  });
});
