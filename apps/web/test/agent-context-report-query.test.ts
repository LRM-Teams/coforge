import { expect, test } from "bun:test";
import {
  readAgentContextReport,
  scanAgentContextReport,
} from "../src/server/agents/agent-context-report.server";
import { decodeAgentContextScanRequest } from "@lrm/coforge-sdk/internal";
import type { AgentContextCache } from "../src/server/centrifugo/agent-context-cache.server";
import type { PrismaClient } from "../generated/client";

type AgentRow = {
  id: string;
  workspaceId: string;
  ownerId: string;
  computerId: string | null;
  runtimeConfig: unknown;
  runtimeSession: unknown;
  currentSession?: { nativeSessionId: string | null } | null;
};

function fakeDb(agent: AgentRow | undefined) {
  return {
    agent: {
      /** Faithful enough: refuses a row that disagrees with the id/workspace/owner/computer
       * filters the query carries, so the authorization fixtures below actually exercise them. */
      async findFirst({ where }: { where?: Record<string, unknown> } = {}) {
        if (!agent) return undefined;
        if (where?.id && where.id !== agent.id) return undefined;
        if (where?.workspaceId && where.workspaceId !== agent.workspaceId) return undefined;
        if (where?.ownerId && where.ownerId !== agent.ownerId) return undefined;
        if (!agent.computerId) return undefined;
        return agent;
      },
    },
  } as unknown as PrismaClient;
}

const claudeAgent: AgentRow = {
  id: "agent-1",
  workspaceId: "workspace-1",
  ownerId: "user-1",
  computerId: "computer-1",
  runtimeConfig: {
    runtime: "claude-code",
    provider: { kind: "default" },
    model: "m",
    modelProvider: "",
    reasoning: "high",
  },
  runtimeSession: { launchId: "launch-1", startRequestId: "r" },
  currentSession: { nativeSessionId: "native-1" },
};

function fakeCache() {
  const scans: unknown[] = [];
  return {
    scans,
    async read() {
      return {
        state: "fresh" as const,
        result: {
          workspaceId: "workspace-1",
          computerId: "computer-1",
          agentId: "agent-1",
          scanId: "scan-0",
          status: "available" as const,
          collectedAt: "2026-09-18T00:00:00Z",
        },
      };
    },
    async putScan(record: unknown) {
      scans.push(record);
    },
    async putResult() {},
  } satisfies AgentContextCache & { scans: unknown[] };
}

const viewer = { userId: "user-1", workspaceId: "workspace-1" };
const online = async () => true;

test("read returns the cached read for the Agent's owner", async () => {
  const read = await readAgentContextReport(fakeDb(claudeAgent), viewer, "agent-1", fakeCache());
  expect(read.status).toBe("ready");
  if (read.status === "ready") expect(read.read.state).toBe("fresh");
});

test("read is unavailable for a viewer who does not own the Agent, a foreign scope, or a non-Claude-Code runtime", async () => {
  for (const agent of [
    undefined,
    { ...claudeAgent, ownerId: "user-2" },
    { ...claudeAgent, workspaceId: "workspace-2" },
    { ...claudeAgent, computerId: null },
    {
      ...claudeAgent,
      runtimeConfig: {
        runtime: "codex",
        provider: { kind: "default" },
        model: "m",
        modelProvider: "",
        reasoning: "high",
      },
    },
  ]) {
    const read = await readAgentContextReport(fakeDb(agent), viewer, "agent-1", fakeCache());
    expect(read.status).toBe("unavailable");
  }
});

test("scan refuses an offline Computer without publishing or recording a pending scan", async () => {
  const cache = fakeCache();
  const published: unknown[] = [];
  const result = await scanAgentContextReport(
    fakeDb(claudeAgent),
    viewer,
    "agent-1",
    { publish: async () => published.push(1) } as never,
    cache,
    async () => false,
  );
  expect(result).toEqual({ status: "offline" });
  expect(published).toHaveLength(0);
  expect(cache.scans).toHaveLength(0);
});

test("scan records the pending scan and publishes the request with the server's own scope", async () => {
  const cache = fakeCache();
  const published: Uint8Array[] = [];
  const result = await scanAgentContextReport(
    fakeDb(claudeAgent),
    viewer,
    "agent-1",
    {
      publish: async (_channel, bytes) => {
        published.push(bytes);
        return Promise.resolve();
      },
    },
    cache,
    online,
  );
  if (!("scanId" in result)) throw new Error(`expected a scan, got ${JSON.stringify(result)}`);
  expect(cache.scans).toMatchObject([
    {
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-1",
      scanId: result.scanId,
      status: "pending",
    },
  ]);
  expect(published).toHaveLength(1);
  // launchId/sessionId are the server's remembered view of the Agent's live session — the daemon
  // validates both against its own state before running anything.
  const decoded = decodeAgentContextScanRequest(published[0]!);
  expect(decoded).toMatchObject({
    protocolMajor: 1,
    workspaceId: "workspace-1",
    computerId: "computer-1",
    agentId: "agent-1",
    provider: "claude-code",
    launchId: "launch-1",
    sessionId: "native-1",
  });
  expect(decoded.messageType).toBe("coforge.rpc.v1.AgentContextScanRequest");
});

test("a malformed persisted runtime config never takes the read down", async () => {
  const read = await readAgentContextReport(
    fakeDb({ ...claudeAgent, runtimeConfig: "not-an-object" }),
    viewer,
    "agent-1",
    fakeCache(),
  );
  expect(read.status).toBe("unavailable");
});
