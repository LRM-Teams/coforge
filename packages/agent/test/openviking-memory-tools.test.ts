import { expect, test } from "bun:test";
import {
  CAUSAL_AGENT_PROTOCOL,
  CAUSAL_OPENVIKING_TOOL_PROFILE,
  CAUSAL_TOOL_NAMES,
  OPENVIKING_AGENT_PROTOCOL,
  OPENVIKING_TOOL_NAMES,
  OPENVIKING_TOOL_PROFILE,
  agentApiRoutes,
} from "@lrm/coforge-sdk/agent";
import {
  CausalMemoryTurnBudget,
  createMemoryFenceTools,
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

test("the openviking-memory fence exposes only ov_* reads, one offer, and channel message tools", () => {
  const names = createMemoryFenceTools(OPENVIKING_TOOL_PROFILE, new CausalMemoryTurnBudget()).map(
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

test("the causal-openviking-memory fence exposes causal tools, read-only ov_* tools, and one offer", () => {
  const names = createMemoryFenceTools(
    CAUSAL_OPENVIKING_TOOL_PROFILE,
    new CausalMemoryTurnBudget(),
  ).map((tool) => tool.name);
  expect(names).toEqual([
    CAUSAL_TOOL_NAMES.search,
    CAUSAL_TOOL_NAMES.trace,
    CAUSAL_TOOL_NAMES.intervene,
    CAUSAL_TOOL_NAMES.proposeCorrection,
    CAUSAL_TOOL_NAMES.offer,
    OPENVIKING_TOOL_NAMES.find,
    OPENVIKING_TOOL_NAMES.searchContext,
    OPENVIKING_TOOL_NAMES.read,
    ...CHANNEL_MESSAGE_TOOLS,
  ]);
  expect(names.filter((name) => name === "memory_offer")).toEqual(["memory_offer"]);
  expect(MUTATION_TOOL_NAMES.some((name) => names.includes(name))).toBe(false);
});

test("a fourth memory read is rejected on both new fences", () => {
  const ovBudget = new CausalMemoryTurnBudget();
  const find = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "find" as const,
    operationId: "f1",
    query: "deploy",
  };
  ovBudget.consume(find);
  ovBudget.consume({ ...find, operationId: "f2" });
  ovBudget.consume({ ...find, operationId: "f3" });
  expect(() => ovBudget.consume({ ...find, operationId: "f4" })).toThrow("read budget");

  const mixed = new CausalMemoryTurnBudget();
  const search = {
    protocol: CAUSAL_AGENT_PROTOCOL,
    op: "search" as const,
    operationId: "s1",
    query: "deploy",
  };
  mixed.consume(search);
  mixed.consume({ ...search, operationId: "s2" });
  mixed.consume(find);
  expect(() => mixed.consume({ ...find, operationId: "f2" })).toThrow("read budget");
});

test("a second Memory Offer is rejected on the openviking fence", () => {
  const budget = new CausalMemoryTurnBudget();
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

test("aggregate token exhaustion rejects the next causal read before a fourth call", () => {
  const budget = new CausalMemoryTurnBudget();
  const search = {
    protocol: CAUSAL_AGENT_PROTOCOL,
    op: "search" as const,
    operationId: "s1",
    query: "deploy",
    tokenBudget: 2400,
  };
  expect(budget.consume(search)).toBe(2400);
  expect(budget.consume({ ...search, operationId: "s2" })).toBe(2400);
  expect(budget.snapshot()).toEqual({
    causalReads: 2,
    offers: 0,
    tokensUsed: 4800,
    tokensRemaining: 0,
  });
  expect(() => budget.consume({ ...search, operationId: "s3", tokenBudget: undefined })).toThrow(
    "token budget exhausted",
  );
});

test("allocates 1600 by default, clamps to remaining, and rejects explicit overshoot", () => {
  const budget = new CausalMemoryTurnBudget();
  const search = {
    protocol: CAUSAL_AGENT_PROTOCOL,
    op: "search" as const,
    operationId: "s1",
    query: "deploy",
  };
  expect(budget.consume(search)).toBe(1600);
  expect(budget.consume({ ...search, operationId: "s2", tokenBudget: 2400 })).toBe(2400);
  expect(budget.consume({ ...search, operationId: "s3" })).toBe(800);
  expect(budget.snapshot().tokensRemaining).toBe(0);

  const overshoot = new CausalMemoryTurnBudget();
  expect(() =>
    overshoot.consume({ ...search, operationId: "too-large", tokenBudget: 3201 }),
  ).toThrow("exceeds per-read maximum");
  overshoot.consume({ ...search, operationId: "large", tokenBudget: 3200 });
  expect(() =>
    overshoot.consume({ ...search, operationId: "over-remaining", tokenBudget: 2000 }),
  ).toThrow("exceeds remaining shared budget");
});

test("the factory rejects a candidate limit above ten before calling the proxy", async () => {
  const proxy = fakeProxy();
  const tools = createMemoryFenceTools(
    OPENVIKING_TOOL_PROFILE,
    new CausalMemoryTurnBudget(),
    proxy,
  );
  await expect(
    executeTool(tools, OPENVIKING_TOOL_NAMES.find, {
      operationId: "too-many",
      query: "deploy",
      limit: 11,
    }),
  ).rejects.toThrow("invalid openviking find limit");
  expect(proxy.calls).toEqual([]);
});

test("reset restores reads, offer, and the shared token pool for the next triggering message", () => {
  const budget = new CausalMemoryTurnBudget();
  const search = {
    protocol: CAUSAL_AGENT_PROTOCOL,
    op: "search" as const,
    operationId: "s1",
    query: "deploy",
    tokenBudget: 3200,
  };
  const offer = {
    protocol: CAUSAL_AGENT_PROTOCOL,
    op: "offer" as const,
    operationId: "o1",
    conversationId: "c",
    targetAgentId: "a",
    recipientRationale: "owns the task",
    citationRefs: ["item:1"],
    body: "cited offer",
  };
  budget.consume(search);
  budget.consume(offer);
  expect(budget.snapshot()).toEqual({
    causalReads: 1,
    offers: 1,
    tokensUsed: 3200,
    tokensRemaining: 1600,
  });
  budget.reset();
  expect(budget.snapshot()).toEqual({
    causalReads: 0,
    offers: 0,
    tokensUsed: 0,
    tokensRemaining: 4800,
  });
  expect(budget.consume({ ...search, operationId: "s2" })).toBe(3200);
  budget.consume({ ...offer, operationId: "o2" });
});

test("ov_* tools post the frozen openviking proxy path and never a mutation verb", async () => {
  const proxy = fakeProxy();
  const tools = createMemoryFenceTools(
    CAUSAL_OPENVIKING_TOOL_PROFILE,
    new CausalMemoryTurnBudget(),
    proxy,
  );
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

test("openviking-memory search_context keeps a native token budget and the 3-read cap", () => {
  const budget = new CausalMemoryTurnBudget(OPENVIKING_TOOL_PROFILE);
  const searchContext = {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "search_context" as const,
    operationId: "c1",
    query: "deploy",
    tokenBudget: 8000,
  };
  expect(budget.consume(searchContext)).toBeUndefined();
  expect(budget.snapshot()).toEqual({
    causalReads: 1,
    offers: 0,
    tokensUsed: 0,
    tokensRemaining: 4800,
  });
  budget.consume({ ...searchContext, operationId: "c2" });
  budget.consume({ ...searchContext, operationId: "c3" });
  expect(() => budget.consume({ ...searchContext, operationId: "c4" })).toThrow("read budget");
});

test("causal-openviking-memory search_context still uses the shared causal token budget", () => {
  const budget = new CausalMemoryTurnBudget(CAUSAL_OPENVIKING_TOOL_PROFILE);
  expect(
    budget.consume({
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "search_context",
      operationId: "c1",
      query: "deploy",
      tokenBudget: 2400,
    }),
  ).toBe(2400);
  expect(budget.snapshot().tokensRemaining).toBe(2400);
});

test("openviking-memory ov_search_context forwards the native tokenBudget unchanged", async () => {
  const proxy = fakeProxy();
  const tools = createMemoryFenceTools(
    OPENVIKING_TOOL_PROFILE,
    new CausalMemoryTurnBudget(OPENVIKING_TOOL_PROFILE),
    proxy,
  );
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

test("a default causal search forwards the allocated 1600-token share", async () => {
  const proxy = fakeProxy();
  const tools = createMemoryFenceTools(
    CAUSAL_OPENVIKING_TOOL_PROFILE,
    new CausalMemoryTurnBudget(),
    proxy,
  );
  await executeTool(tools, CAUSAL_TOOL_NAMES.search, {
    operationId: "search-1",
    query: "why did the deploy roll back",
  });
  expect(proxy.calls[0]).toEqual({
    path: agentApiRoutes.proxy.causal.path,
    body: {
      protocol: CAUSAL_AGENT_PROTOCOL,
      op: "search",
      operationId: "search-1",
      query: "why did the deploy roll back",
      tokenBudget: 1600,
    },
  });
});
