import { expect, test } from "bun:test";
import { createAgentContextScanResultMethod } from "@/server/centrifugo/rpc-handler.server";
import { encodeAgentContextScanResponse } from "@lrm/coforge-sdk/internal";

const principal = (agentId?: string) => ({
  userId: "user-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId,
});

function fakeCache() {
  const records: unknown[] = [];
  return {
    records,
    async putScan() {},
    async putResult(record: unknown) {
      records.push(record);
    },
    async read() {
      return { state: "missing" as const };
    },
  };
}

const payload = (overrides: Record<string, unknown> = {}) =>
  encodeAgentContextScanResponse({
    protocolMajor: 1,
    requestId: "context-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    agentId: "agent-1",
    provider: "claude-code",
    launchId: "launch-1",
    sessionId: "native-session-1",
    accepted: true,
    status: "available",
    messageType: "coforge.rpc.v1.AgentContextScanResponse",
    ...overrides,
  });

test("stores an available Agent context result with its report and observation time", async () => {
  const cache = fakeCache();
  const method = createAgentContextScanResultMethod(cache);
  const report = {
    provider: "claude-code",
    usedTokens: 24_900,
    windowTokens: 200_000,
    observedAt: "2026-09-16T12:00:00.000Z",
    categories: [{ name: "Free space", tokens: 175_100 }],
  };
  const bytes = payload({
    reportJson: new TextEncoder().encode(JSON.stringify(report)),
  });

  expect(await method(bytes, { principal: principal() })).toBeInstanceOf(Uint8Array);
  expect(cache.records).toEqual([
    {
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-1",
      scanId: "context-1",
      status: "available",
      message: undefined,
      report,
      // The report's own observedAt becomes the stored result's collectedAt.
      collectedAt: "2026-09-16T12:00:00.000Z",
    },
  ]);
});

test("a non-available result stores the status and message without a report", async () => {
  const cache = fakeCache();
  const method = createAgentContextScanResultMethod(cache);
  const bytes = payload({ accepted: false, status: "no_session", reportJson: undefined });

  expect(await method(bytes, { principal: principal() })).toBeInstanceOf(Uint8Array);
  expect(cache.records).toMatchObject([
    { status: "no_session", report: undefined, collectedAt: expect.any(String) },
  ]);
});

test.each([
  ["garbage bytes", payload({ reportJson: new TextEncoder().encode("{not json") })],
  [
    "a foreign provider",
    payload({
      reportJson: new TextEncoder().encode(
        JSON.stringify({
          provider: "codex",
          usedTokens: 1,
          windowTokens: 2,
          observedAt: "2026-09-16T12:00:00.000Z",
          categories: [{ name: "A", tokens: 1 }],
        }),
      ),
    }),
  ],
  [
    "a missing category table",
    payload({
      reportJson: new TextEncoder().encode(
        JSON.stringify({
          provider: "claude-code",
          usedTokens: 1,
          windowTokens: 2,
          observedAt: "2026-09-16T12:00:00.000Z",
          categories: [],
        }),
      ),
    }),
  ],
  [
    "an unbounded category name",
    payload({
      reportJson: new TextEncoder().encode(
        JSON.stringify({
          provider: "claude-code",
          usedTokens: 1,
          windowTokens: 2,
          observedAt: "2026-09-16T12:00:00.000Z",
          categories: [{ name: "x".repeat(300), tokens: 1 }],
        }),
      ),
    }),
  ],
  [
    "a negative token count",
    payload({
      reportJson: new TextEncoder().encode(
        JSON.stringify({
          provider: "claude-code",
          usedTokens: -1,
          windowTokens: 2,
          observedAt: "2026-09-16T12:00:00.000Z",
          categories: [{ name: "A", tokens: 1 }],
        }),
      ),
    }),
  ],
  [
    "a malformed observedAt",
    payload({
      reportJson: new TextEncoder().encode(
        JSON.stringify({
          provider: "claude-code",
          usedTokens: 1,
          windowTokens: 2,
          observedAt: "not-a-date",
          categories: [{ name: "A", tokens: 1 }],
        }),
      ),
    }),
  ],
])("rejects an Agent context report that %s", async (_case, bytes) => {
  const cache = fakeCache();
  const method = createAgentContextScanResultMethod(cache);
  expect(await method(bytes, { principal: principal() })).toEqual({
    code: 400,
    message: "invalid Agent context scan result",
  });
  expect(cache.records).toEqual([]);
});

test("rejects a result whose transport principal is not that Computer's daemon", async () => {
  const cache = fakeCache();
  const method = createAgentContextScanResultMethod(cache);
  const bytes = payload({
    reportJson: new TextEncoder().encode(
      JSON.stringify({
        provider: "claude-code",
        usedTokens: 1,
        windowTokens: 2,
        observedAt: "2026-09-16T12:00:00.000Z",
        categories: [{ name: "A", tokens: 1 }],
      }),
    ),
  });
  expect(
    await method(bytes, { principal: { ...principal(), computerId: "another-computer" } }),
  ).toEqual({ code: 403, message: "daemon runtime identity is not authorized" });
  expect(await method(bytes, { principal: principal("agent-9") })).toEqual({
    code: 403,
    message: "daemon runtime identity is not authorized",
  });
  expect(cache.records).toEqual([]);
});
