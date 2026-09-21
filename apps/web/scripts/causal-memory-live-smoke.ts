#!/usr/bin/env bun
import { readFileSync } from "node:fs";

/**
 * Opt-in live-LLM Causal Memory smoke (W4).
 *
 * Guarded by explicit environment variables and a disposable tenant. It is not
 * part of `mise run test`. Invoke only against a dedicated smoke tenant:
 *
 *   COFORGE_CAUSAL_LIVE_SMOKE=1 \
 *   COFORGE_CAUSAL_MEMORY_URL=http://127.0.0.1:9938 \
 *   COFORGE_CAUSAL_MEMORY_TENANT_TOKENS_FILE=/path/to/tokens.json \
 *   COFORGE_CAUSAL_LIVE_SMOKE_TENANT=smoke-tenant \
 *   bun apps/web/scripts/causal-memory-live-smoke.ts
 *
 * The script posts one admitted-segment distill and one `@memory` search through
 * the private runtime contract, then prints sanitized pass/fail. It never prints
 * bearer tokens or model credentials.
 */

const required = [
  "COFORGE_CAUSAL_LIVE_SMOKE",
  "COFORGE_CAUSAL_MEMORY_URL",
  "COFORGE_CAUSAL_MEMORY_TENANT_TOKENS_FILE",
  "COFORGE_CAUSAL_LIVE_SMOKE_TENANT",
] as const;

if (process.env.COFORGE_CAUSAL_LIVE_SMOKE !== "1") {
  console.log("causal live smoke skipped: set COFORGE_CAUSAL_LIVE_SMOKE=1 to run");
  process.exit(0);
}

for (const key of required) {
  if (!process.env[key]) {
    console.error(`causal live smoke missing ${key}`);
    process.exit(2);
  }
}

const tokens = JSON.parse(
  readFileSync(process.env.COFORGE_CAUSAL_MEMORY_TENANT_TOKENS_FILE!, "utf8"),
) as Record<string, string>;
const tenant = process.env.COFORGE_CAUSAL_LIVE_SMOKE_TENANT!;
const token = Object.entries(tokens).find(([, name]) => name === tenant)?.[0];
if (!token) {
  console.error("causal live smoke tenant is not in the token file");
  process.exit(2);
}

const base = process.env.COFORGE_CAUSAL_MEMORY_URL!;
const operationId = `smoke-${crypto.randomUUID()}`;
const messageId = crypto.randomUUID();
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "X-Coforge-Operation-Id": operationId,
};

async function post(path: string, body: unknown, headerOperationId = operationId) {
  const response = await fetch(new URL(path, base), {
    method: "POST",
    headers: { ...headers, "X-Coforge-Operation-Id": headerOperationId },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => undefined)) as
    | { error?: { code?: string } }
    | undefined;
  if (!response.ok) throw new Error(payload?.error?.code ?? `http_${response.status}`);
  return payload;
}

try {
  const health = await fetch(new URL("/readyz", base));
  if (!health.ok) throw new Error("readyz_failed");
  const turnOp = `${operationId}-turn`;
  await post(
    "/coforge/v1/audit/turns",
    {
      protocol: "coforge.causal.runtime.v1",
      operationId: turnOp,
      session: { workspaceId: "smoke", channelId: "smoke" },
      turn: {
        messageId,
        sequence: 1,
        occurredAt: new Date().toISOString(),
        payloadHash: "sha256:smoke",
        senderKind: "human",
        senderHandle: "smoke",
        body: "SMOKE: skipped tests and the deploy rolled back",
      },
    },
    turnOp,
  );
  await post("/coforge/v1/segments/distill", {
    protocol: "coforge.causal.runtime.v1",
    operationId,
    segment: {
      admittedSegmentId: `smoke-${messageId}`,
      kind: "completed_task",
      sourceMessageIds: [messageId],
      sourcePayloadHash: "sha256:smoke",
    },
  });
  const found = (await post(
    "/coforge/v1/search",
    {
      protocol: "coforge.causal.runtime.v1",
      operationId: `${operationId}-search`,
      query: "deploy rolled back",
    },
    `${operationId}-search`,
  )) as { items?: Array<{ sourceMessageIds?: string[] }> };
  if (!found.items?.some((item) => item.sourceMessageIds?.includes(messageId)))
    throw new Error("search_ungrounded");
  console.log("causal live smoke passed");
} catch (error) {
  console.error(`causal live smoke failed: ${error instanceof Error ? error.message : "unknown"}`);
  process.exit(1);
}
