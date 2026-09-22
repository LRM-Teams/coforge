import { expect, test } from "bun:test";
import { OPENVIKING_CITATION_KIND } from "@lrm/coforge-sdk/agent";
import type { OpenVikingCitationRecord } from "../db/repositories/workspace-memory-citation.repositories.server";
import {
  createInMemoryCausalMemoryCitationBindings,
  createMemoryCitationBindings,
} from "./memory-citations";
import { createOpenVikingMemoryReads } from "./openviking-memory-reads";
import type { OpenVikingMemoryReadInvocation } from "../openviking/memory-agent-reads";

function harness(results: unknown) {
  const calls: OpenVikingMemoryReadInvocation[] = [];
  const ovRows = new Map<string, OpenVikingCitationRecord>();
  const citations = createMemoryCitationBindings({
    openviking: {
      async putOpenVikingCitation(record) {
        ovRows.set(`${record.workspaceId}:${record.citationId}`, record);
        return record;
      },
      async getOpenVikingCitation(workspaceId, citationId) {
        return ovRows.get(`${workspaceId}:${citationId}`) ?? null;
      },
    },
    causal: createInMemoryCausalMemoryCitationBindings(),
  });
  const reads = createOpenVikingMemoryReads({
    client: {
      async invoke(request) {
        calls.push(request);
        return results;
      },
    },
    citations,
  });
  return { reads, calls, ovRows };
}

test("find and read bind OpenViking citations through the injected client", async () => {
  const { reads, calls, ovRows } = harness({
    results: [
      {
        uri: "viking://resources/docs/deploy.md",
        accountId: "acct-a",
        contentHash: "sha256:abc",
        matchedLevel: "L2",
        title: "Deploy rollback",
        excerpt: "skipped tests",
      },
    ],
  });
  const found = await reads.find({
    workspaceId: "ws-a",
    agentId: "mem-1",
    operationId: "find-1",
    query: "deploy",
  });
  expect(found[0]).toMatchObject({
    kind: OPENVIKING_CITATION_KIND,
    uri: "viking://resources/docs/deploy.md",
    matchedLevel: "L2",
  });
  expect(calls[0]).toEqual({
    workspaceId: "ws-a",
    agentId: "mem-1",
    operation: "find",
    body: { query: "deploy", limit: 10 },
  });
  expect(ovRows.get("ws-a:ov:viking://resources/docs/deploy.md")?.boundOperationId).toBe("find-1");

  const reader = harness({
    uri: "viking://resources/docs/runbook.md",
    accountId: "acct-a",
    content: "on-call runbook",
    title: "Runbook",
  });
  const read = await reader.reads.read({
    workspaceId: "ws-a",
    agentId: "mem-1",
    operationId: "read-1",
    uri: "viking://resources/docs/runbook.md",
  });
  expect(read.citation.kind).toBe(OPENVIKING_CITATION_KIND);
  expect(read.content).toBe("on-call runbook");
  expect(reader.calls[0]).toEqual({
    workspaceId: "ws-a",
    agentId: "mem-1",
    operation: "read",
    query: { uri: "viking://resources/docs/runbook.md" },
  });
});

test("search_context disables query expansion and never issues an OpenViking write", async () => {
  const { reads, calls } = harness({ results: [] });
  await reads.searchContext({
    workspaceId: "ws-a",
    agentId: "mem-1",
    operationId: "ctx-1",
    query: "deploy",
    tokenBudget: 1600,
  });
  expect(calls[0]).toEqual({
    workspaceId: "ws-a",
    agentId: "mem-1",
    operation: "search_context",
    body: { query: "deploy", limit: 10, query_expansion: "off", token_budget: 1600 },
  });
  expect(JSON.stringify(calls[0])).not.toContain("write");
  await expect(
    reads.find({
      workspaceId: "ws-a",
      agentId: "mem-1",
      operationId: "write-1",
      query: "x",
    }),
  ).resolves.toEqual([]);
});
