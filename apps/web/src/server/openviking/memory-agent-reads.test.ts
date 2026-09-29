import { expect, test } from "bun:test";
import {
  createCatalogOpenVikingMemoryReadClient,
  MemoryAgentMutationError,
  memoryAgentReadRoute,
} from "./memory-agent-reads";
import { lookupAggregatedRoute } from "./catalog/aggregated-catalog";

test("Memory Agent reads resolve through the classified OpenViking catalog", () => {
  const find = memoryAgentReadRoute("find");
  const search = memoryAgentReadRoute("search_context");
  const read = memoryAgentReadRoute("read");
  expect(lookupAggregatedRoute(find.method, find.path)?.classification).toBe("data-plane");
  expect(lookupAggregatedRoute(search.method, search.path)?.classification).toBe("data-plane");
  expect(lookupAggregatedRoute(read.method, read.path)?.classification).toBe("data-plane");
  expect(find.path.endsWith("/search/find")).toBe(true);
  expect(search.path.endsWith("/search/search")).toBe(true);
  expect(read.path.endsWith("/content/read")).toBe(true);
});

test("catalog client forwards named operations and rejects unknown mutations", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const client = createCatalogOpenVikingMemoryReadClient({
    async forward(request) {
      calls.push({ method: request.method, path: request.path, body: request.body });
      return { results: [] };
    },
  });
  await client.invoke({
    workspaceId: "ws-a",
    agentId: "mem-1",
    operation: "find",
    body: { query: "deploy", limit: 10 },
  });
  expect(calls[0]).toEqual({
    method: "POST",
    path: memoryAgentReadRoute("find").path,
    body: { query: "deploy", limit: 10 },
  });
  await expect(
    client.invoke({
      workspaceId: "ws-a",
      agentId: "mem-1",
      operation: "write" as never,
      body: { uri: "viking://resources/x.md", content: "nope" },
    }),
  ).rejects.toBeInstanceOf(MemoryAgentMutationError);
});
