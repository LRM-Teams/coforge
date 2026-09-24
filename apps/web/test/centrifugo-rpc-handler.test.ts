import { describe, expect, test } from "bun:test";
import {
  CentrifugoRpcAuthenticationError,
  CentrifugoRpcHandler,
  createAgentDeliveryAckMethod,
  createAgentStatusMethod,
  createDaemonRuntimeCodeAgentsUpdateMethod,
  createDaemonRuntimeReadyMethod,
  createDaemonRuntimeUsageScanResultMethod,
  createDaemonRuntimeProviderModelRefreshResultMethod,
  createComputerUpgradeResultMethod,
  createDaemonConnectionStatusMethod,
  type CentrifugoRpcMethod,
} from "#src/server/centrifugo/rpc-handler.server";
import { createCentrifugoRpcHandler } from "#src/server/centrifugo/rpc-composition.server";
import { AgentMessageValidationError } from "#src/server/conversations/agent-message-validation-error.server";
import {
  encodeAgentMessageDeliveryAck,
  encodeAgentStatus,
  encodeDaemonRuntimeCodeAgentsUpdateRequest,
  encodeDaemonRuntimeProviderModelRefreshResponse,
  encodeDaemonRuntimeReadyRequest,
  encodeDaemonRuntimeUsageScanResponse,
  encodeComputerUpgradeResult,
} from "@lrm/coforge-sdk/internal";

const encoded = (value: string) => btoa(value);
const json = (value: unknown) =>
  new Request("http://handler", {
    method: "POST",
    body: JSON.stringify(value),
  });
const authorizedJson = (value: unknown) =>
  new Request("http://handler", {
    method: "POST",
    headers: { "x-coforge-centrifugo-proxy-secret": "test-secret" },
    body: JSON.stringify(value),
  });

const principal = (agentId?: string) => ({
  userId: "user-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId,
});

const upgradeResultPayload = (
  value: Partial<Parameters<typeof encodeComputerUpgradeResult>[0]> = {},
) =>
  encodeComputerUpgradeResult({
    protocolMajor: 1,
    requestId: "operation-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    status: "failed",
    completedAtMs: 1_700_000_000_000,
    error: "candidate failed",
    ...value,
  });

describe("Computer upgrade result method", () => {
  test("records the Daemon's terminal report and answers with the acknowledgement", async () => {
    const reported: unknown[] = [];
    const method = createComputerUpgradeResultMethod({
      reported: async (scope, result) => {
        reported.push([scope, result]);
      },
    });

    const reply = await method(upgradeResultPayload(), { principal: principal() });

    expect(reply).toBeInstanceOf(Uint8Array);
    expect(reported).toEqual([
      [
        { workspaceId: "workspace-1", computerId: "computer-1" },
        {
          requestId: "operation-1",
          status: "failed",
          completedAtMs: 1_700_000_000_000,
          error: "candidate failed",
        },
      ],
    ]);
  });

  test("carries the Daemon's error code through to the store", async () => {
    const reported: unknown[] = [];
    const method = createComputerUpgradeResultMethod({
      reported: async (scope, result) => {
        reported.push([scope, result]);
      },
    });

    await method(upgradeResultPayload({ errorCode: "UPGRADE_OPERATION_PENDING" }), {
      principal: principal(),
    });

    expect(reported).toEqual([
      [
        { workspaceId: "workspace-1", computerId: "computer-1" },
        {
          requestId: "operation-1",
          status: "failed",
          completedAtMs: 1_700_000_000_000,
          error: "candidate failed",
          errorCode: "UPGRADE_OPERATION_PENDING",
        },
      ],
    ]);
  });

  test("refuses a report for another Computer and an undecodable payload", async () => {
    const method = createComputerUpgradeResultMethod({
      reported: async () => {
        throw new Error("must not be called");
      },
    });

    expect(
      await method(upgradeResultPayload(), {
        principal: { ...principal(), computerId: "computer-2" },
      }),
    ).toMatchObject({ code: 403 });
    expect(await method(new Uint8Array([1, 2, 3]), { principal: principal() })).toEqual({
      code: 400,
      message: "invalid Computer upgrade result",
    });
  });

  test("a store failure is a retryable error, never a silent acknowledgement", async () => {
    const method = createComputerUpgradeResultMethod({
      reported: async () => {
        throw new Error("redis unavailable");
      },
    });

    expect(await method(upgradeResultPayload(), { principal: principal() })).toMatchObject({
      code: 503,
    });
  });
});

describe("Daemon connection status method", () => {
  const statusPayload = (value: Record<string, unknown>) =>
    new TextEncoder().encode(JSON.stringify(value));

  test("a periodic online status persists a legacy leased identity without an expiry", async () => {
    const touched: unknown[] = [];
    const method = createDaemonConnectionStatusMethod(
      { put: async () => {}, get: async () => true, getMany: async () => [] },
      undefined,
      {
        touchIdentity: async (scope) => {
          touched.push(scope);
        },
      },
    );

    const reply = await method(
      statusPayload({ workspaceId: "workspace-1", computerId: "computer-1", online: true }),
      { principal: principal() },
    );

    expect(reply).toBeInstanceOf(Uint8Array);
    expect(touched).toEqual([{ workspaceId: "workspace-1", computerId: "computer-1" }]);
  });

  test("an offline status never renews an identity for a Computer that just disconnected", async () => {
    const touched: unknown[] = [];
    const method = createDaemonConnectionStatusMethod(
      { put: async () => {}, get: async () => false, getMany: async () => [] },
      undefined,
      {
        touchIdentity: async (scope) => {
          touched.push(scope);
        },
      },
    );

    await method(
      statusPayload({ workspaceId: "workspace-1", computerId: "computer-1", online: false }),
      { principal: principal() },
    );

    expect(touched).toEqual([]);
  });

  test("an unauthorized status is refused before it can renew anything", async () => {
    const touched: unknown[] = [];
    const method = createDaemonConnectionStatusMethod(
      { put: async () => {}, get: async () => true, getMany: async () => [] },
      undefined,
      {
        touchIdentity: async (scope) => {
          touched.push(scope);
        },
      },
    );

    expect(
      await method(
        statusPayload({ workspaceId: "workspace-2", computerId: "computer-1", online: true }),
        { principal: principal() },
      ),
    ).toMatchObject({ code: 403 });
    expect(touched).toEqual([]);
  });
});

describe("CentrifugoRpcHandler", () => {
  test("exposes only typed Agent message validation failures", async () => {
    for (const [failure, expected] of [
      [
        new AgentMessageValidationError("ambiguous message prefix; use the full UUID"),
        { code: 400, message: "ambiguous message prefix; use the full UUID" },
      ],
      [new Error("database password leaked"), { code: 500, message: "RPC method failed" }],
    ] as const) {
      const handler = new CentrifugoRpcHandler({
        methods: {
          read: async () => {
            throw failure;
          },
        },
      });

      const response = await handler.handleRequest(json({ method: "read", b64data: "AA==" }));
      expect(await response.json()).toEqual({ error: expected });
    }
  });

  test("authorizes delivery ACKs against the authenticated Computer", async () => {
    const received: unknown[] = [];
    const method = createAgentDeliveryAckMethod({
      async receiveDeliveryAck(input) {
        if (input.computerId !== "computer-1") throw new Error("wrong Computer");
        received.push(input);
      },
    });
    const payload = encodeAgentMessageDeliveryAck({
      protocolMajor: 1,
      method: "agent:v1:message:ack",
      requestId: "request-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
      messageId: "message-1",
      sequence: 1,
    });

    expect(
      await method(payload, {
        principal: { ...principal(), computerId: "computer-2" },
      }),
    ).toEqual({
      code: 403,
      message: "delivery acknowledgement is not authorized",
    });
    expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      computerId: "computer-1",
      deliveryId: "delivery-1",
    });
  });

  test("accepts a scoped Agent status from its assigned Computer", async () => {
    const statuses: unknown[] = [];
    const publications: unknown[] = [];
    const displayObservations: unknown[] = [];
    const method = createAgentStatusMethod(
      {
        getById: async () => ({
          id: "agent-1",
          workspaceId: "workspace-1",
          ownerId: "another-workspace-member",
          computerId: "computer-1",
          visibility: "public",
        }),
      },
      {
        put: async (status) => {
          statuses.push(status);
          return true;
        },
        get: async () => "inactive",
        snapshot: async () => undefined,
        snapshotMany: async () => [],
      },
      {
        publish: async (channel, data) => {
          publications.push({
            channel,
            data: JSON.parse(new TextDecoder().decode(data)),
          });
        },
      },
      () => 1_000,
      {
        observeStatus: async (status) => {
          displayObservations.push(status);
          return {
            protocolMajor: 1,
            workspaceId: "workspace-1",
            computerId: "computer-1",
            agentId: "agent-1",
            revision: 1,
            activityKind: "online",
            detailKind: "",
            detail: "",
            entries: [],
            expiresAt: 91_000,
          };
        },
      },
      {
        publishJson: async (channel, data) => {
          publications.push({ channel, data });
        },
      },
    );
    const payload = encodeAgentStatus({
      protocolMajor: 1,
      requestId: "status-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-1",
      status: "active",
      daemonInstanceId: "daemon-1",
      clientSeq: 1,
      observedAtMs: 1_000,
    });

    expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);
    expect(statuses).toEqual([
      {
        protocolMajor: 1,
        requestId: "status-1",
        workspaceId: "workspace-1",
        computerId: "computer-1",
        agentId: "agent-1",
        status: "active",
        daemonInstanceId: "daemon-1",
        clientSeq: 1,
        observedAtMs: 1_000,
      },
    ]);
    expect(displayObservations).toHaveLength(1);
    expect(publications).toEqual([
      {
        channel: "agent:status:workspace-1",
        data: {
          agentId: "agent-1",
          status: "active",
          expiresAt: 91_000,
          daemonInstanceId: "daemon-1",
          clientSeq: 1,
          observedAtMs: 1_000,
        },
      },
      {
        channel: "agent:status:workspace-1",
        data: {
          type: "agent:display",
          protocolMajor: 1,
          workspaceId: "workspace-1",
          computerId: "computer-1",
          agentId: "agent-1",
          revision: 1,
          activityKind: "online",
          detailKind: "",
          detail: "",
          entries: [],
          expiresAt: 91_000,
        },
      },
    ]);
    expect(
      await method(payload, {
        principal: { ...principal(), computerId: "computer-2" },
      }),
    ).toEqual({ code: 403, message: "Agent status is not authorized" });
  });

  // `agent:status` reports feed both the raw active/inactive event and the reduced
  // `agent:display` snapshot onto the browser status channel — the same per-Agent-or-shared split
  // the publish proxy, the Activity sweep and the context-usage receiver already apply, folded
  // into the same Agent row this method already fetches for authorization above (no extra query).
  test("routes both the status event and its display snapshot to a private Agent's per-Agent status channel", async () => {
    const publications: Array<{ channel: string }> = [];
    const method = createAgentStatusMethod(
      {
        getById: async () => ({
          workspaceId: "workspace-1",
          computerId: "computer-1",
          visibility: "private",
        }),
      },
      {
        put: async () => true,
        get: async () => "inactive",
        snapshot: async () => undefined,
        snapshotMany: async () => [],
      },
      { publish: async (channel) => void publications.push({ channel }) },
      () => 1_000,
      {
        observeStatus: async () => ({
          protocolMajor: 1,
          workspaceId: "workspace-1",
          computerId: "computer-1",
          agentId: "agent-1",
          revision: 1,
          activityKind: "online",
          detailKind: "",
          detail: "",
          entries: [],
          expiresAt: 91_000,
        }),
      },
      { publishJson: async (channel) => void publications.push({ channel }) },
    );
    const payload = encodeAgentStatus({
      protocolMajor: 1,
      requestId: "status-private",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-1",
      status: "active",
      daemonInstanceId: "daemon-1",
      clientSeq: 1,
      observedAtMs: 1_000,
    });

    expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);

    expect(publications).toEqual([
      { channel: "agent:status:workspace-1:agent-1" },
      { channel: "agent:status:workspace-1:agent-1" },
    ]);
  });

  // Never optional in effect: a lookup that cannot answer the visibility question must not
  // silently fall back to publishing on the shared channel. The process lease is still accepted
  // independently of this decision.
  test("skips fan-out (but still accepts the process lease) when the Agent row carries no visibility field", async () => {
    const statuses: unknown[] = [];
    const publications: Array<{ channel: string }> = [];
    const method = createAgentStatusMethod(
      { getById: async () => ({ workspaceId: "workspace-1", computerId: "computer-1" }) },
      {
        put: async (status) => {
          statuses.push(status);
          return true;
        },
        get: async () => "inactive",
        snapshot: async () => undefined,
        snapshotMany: async () => [],
      },
      { publish: async (channel) => void publications.push({ channel }) },
    );
    const payload = encodeAgentStatus({
      protocolMajor: 1,
      requestId: "status-unset-visibility",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-1",
      status: "active",
      daemonInstanceId: "daemon-1",
      clientSeq: 1,
      observedAtMs: 1_000,
    });

    expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);

    expect(statuses).toHaveLength(1);
    expect(publications).toHaveLength(0);
  });

  test("updates Agent display even when status channel publish fails", async () => {
    const displayObservations: unknown[] = [];
    const method = createAgentStatusMethod(
      {
        getById: async () => ({
          workspaceId: "workspace-1",
          computerId: "computer-1",
        }),
      },
      {
        put: async () => true,
        get: async () => "active",
        snapshot: async () => undefined,
        snapshotMany: async () => [],
      },
      {
        publish: async () => {
          throw new Error("Centrifugo publish failed (102)");
        },
      },
      () => 1_000,
      {
        observeStatus: async (status) => {
          displayObservations.push(status);
          return {
            protocolMajor: 1,
            workspaceId: "workspace-1",
            computerId: "computer-1",
            agentId: "agent-1",
            revision: 1,
            activityKind: "online",
            detailKind: "",
            detail: "",
            entries: [],
            expiresAt: 91_000,
          };
        },
      },
    );
    const result = await method(
      encodeAgentStatus({
        protocolMajor: 1,
        requestId: "status-publish-fail",
        workspaceId: "workspace-1",
        computerId: "computer-1",
        agentId: "agent-1",
        status: "active",
        daemonInstanceId: "daemon-1",
        clientSeq: 1,
        observedAtMs: 1_000,
      }),
      { principal: principal() },
    );
    expect(result).toBeInstanceOf(Uint8Array);
    expect(displayObservations).toHaveLength(1);
  });

  test("does not publish stale handler input", async () => {
    const publications: unknown[] = [];
    const method = createAgentStatusMethod(
      {
        getById: async () => ({
          workspaceId: "workspace-1",
          computerId: "computer-1",
        }),
      },
      {
        put: async () => false,
        get: async () => "active",
        snapshot: async () => undefined,
        snapshotMany: async () => [],
      },
      {
        publish: async (...args) => {
          publications.push(args);
        },
      },
    );
    await method(
      encodeAgentStatus({
        protocolMajor: 1,
        requestId: "stale",
        workspaceId: "workspace-1",
        computerId: "computer-1",
        agentId: "agent-1",
        status: "inactive",
        daemonInstanceId: "daemon-1",
        clientSeq: 1,
        observedAtMs: 1,
      }),
      { principal: principal() },
    );
    expect(publications).toEqual([]);
  });

  test("replaces the exact Computer's external Code Agent snapshot", async () => {
    const updates: unknown[] = [];
    const method = createDaemonRuntimeCodeAgentsUpdateMethod({
      replace: async (scope, runtimes, catalogs) => updates.push({ scope, runtimes, catalogs }),
    });
    const payload = encodeDaemonRuntimeCodeAgentsUpdateRequest({
      protocolMajor: 1,
      requestId: "inventory-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      runtimes: [{ provider: "codex", version: "0.151.0", displayName: "Codex" }],
      catalogs: [{ provider: "codex", models: [] }],
    });

    expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);
    expect(updates).toEqual([
      {
        scope: { workspaceId: "workspace-1", computerId: "computer-1" },
        runtimes: [{ provider: "codex", version: "0.151.0", displayName: "Codex" }],
        catalogs: [{ provider: "codex", models: [] }],
      },
    ]);
    expect(
      await method(payload, {
        principal: { ...principal(), computerId: "computer-2" },
      }),
    ).toEqual({
      code: 403,
      message: "daemon runtime identity is not authorized",
    });
  });

  test("accepts all supported Provider catalogs without a model-count cap and rejects duplicates", async () => {
    const updates: unknown[] = [];
    const method = createDaemonRuntimeCodeAgentsUpdateMethod({
      replace: async (_scope, _runtimes, catalogs) => updates.push(catalogs),
    });
    const request = {
      protocolMajor: 1,
      requestId: "inventory-many",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      runtimes: [],
      catalogs: [
        { provider: "coforge", models: [] },
        {
          provider: "pi",
          models: Array.from({ length: 401 }, (_, index) => ({
            id: `model-${index}`,
            displayName: `Model ${index}`,
            description: "",
            modelProvider: "openrouter",
            defaultReasoning: "",
            reasoningEfforts: [],
            recommended: false,
          })),
        },
        { provider: "codex", models: [] },
        { provider: "claude-code", models: [] },
        { provider: "kiro", models: [] },
      ],
    } satisfies Parameters<typeof encodeDaemonRuntimeCodeAgentsUpdateRequest>[0];
    expect(
      await method(encodeDaemonRuntimeCodeAgentsUpdateRequest(request), {
        principal: principal(),
      }),
    ).toBeInstanceOf(Uint8Array);
    expect(updates).toEqual([request.catalogs]);
    expect(
      await method(
        encodeDaemonRuntimeCodeAgentsUpdateRequest({
          ...request,
          catalogs: [request.catalogs[0]!, request.catalogs[0]!],
        }),
        { principal: principal() },
      ),
    ).toEqual({ code: 400, message: "invalid Code Agent inventory" });
    expect(updates).toHaveLength(1);
  });

  test("starts every existing Workspace Agent after the exact Computer reports ready", async () => {
    const recovered: unknown[][] = [];
    const observed: unknown[] = [];
    const method = createDaemonRuntimeReadyMethod(
      {
        recoverWorkspace: async (workspaceId, computerId, runningAgentIds) => {
          recovered.push([workspaceId, computerId, runningAgentIds]);
        },
      },
      undefined,
      undefined,
      undefined,
      async (scope, metadata) => {
        observed.push({ scope, metadata });
      },
    );
    const payload = encodeDaemonRuntimeReadyRequest({
      protocolMajor: 1,
      requestId: "ready-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      workerInstanceId: "worker-1",
      daemonVersion: "1.2.3",
      computerVersion: "4.5.6",
      platform: "darwin",
      osVersion: "26.1",
      startedAt: 1,
      runningAgentIds: ["agent-running"],
      recoveredRestartRequestIds: ["restart-1"],
      recoveredUpgradeRequestIds: [],
    });

    expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);
    expect(observed).toEqual([
      {
        scope: { workspaceId: "workspace-1", computerId: "computer-1" },
        metadata: { computerVersion: "4.5.6", platform: "darwin", osVersion: "26.1", startedAt: 1 },
      },
    ]);
    expect(recovered).toEqual([["workspace-1", "computer-1", ["agent-running"]]]);
    const missingRecoveryEvidence = encodeDaemonRuntimeReadyRequest({
      protocolMajor: 1,
      requestId: "ready-legacy",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      workerInstanceId: "worker-legacy",
      startedAt: 1,
      runningAgentIds: [],
    });
    expect(await method(missingRecoveryEvidence, { principal: principal() })).toEqual({
      code: 400,
      message: "invalid daemon runtime ready request",
    });
    expect(
      await method(payload, {
        principal: { ...principal(), computerId: "another-computer" },
      }),
    ).toEqual({
      code: 403,
      message: "daemon runtime identity is not authorized",
    });
    expect(recovered).toEqual([["workspace-1", "computer-1", ["agent-running"]]]);
    expect(observed).toHaveLength(1);
  });

  test("rejects invalid observed metadata before persistence", async () => {
    let writes = 0;
    const method = createDaemonRuntimeReadyMethod(
      undefined,
      undefined,
      undefined,
      undefined,
      async () => {
        writes++;
      },
    );
    for (const metadata of [
      { platform: "invented-os" },
      { computerVersion: "v".repeat(201) },
      { startedAt: -1 },
    ]) {
      const payload = encodeDaemonRuntimeReadyRequest({
        protocolMajor: 1,
        requestId: "ready-1",
        workspaceId: "workspace-1",
        computerId: "computer-1",
        workerInstanceId: "worker-1",
        daemonVersion: "1.2.3",
        startedAt: 1,
        runningAgentIds: [],
        recoveredRestartRequestIds: [],
        recoveredUpgradeRequestIds: [],
        ...metadata,
      });
      expect(await method(payload, { principal: principal() })).toEqual({
        code: 400,
        message: "invalid Computer metadata",
      });
    }
    expect(writes).toBe(0);
  });

  test("stores an available Daemon usage result as available", async () => {
    const records: unknown[] = [];
    const method = createDaemonRuntimeUsageScanResultMethod({
      async putScan() {},
      async putResult(record) {
        records.push(record);
      },
      async read() {
        return { state: "missing" };
      },
    });
    const snapshot = {
      provider: "codex",
      planType: "pro",
      primary: {
        usedPercent: 25,
        windowDurationMinutes: 300,
        resetsAt: "2026-09-04T03:00:00.000Z",
      },
    };
    const payload = encodeDaemonRuntimeUsageScanResponse({
      protocolMajor: 1,
      requestId: "usage-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      provider: "codex",
      accepted: true,
      status: "available",
      snapshotJson: new TextEncoder().encode(JSON.stringify(snapshot)),
    });

    expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);
    expect(records).toEqual([
      {
        workspaceId: "workspace-1",
        computerId: "computer-1",
        provider: "codex",
        scanId: "usage-1",
        status: "available",
        message: undefined,
        snapshot,
        collectedAt: expect.any(String),
      },
    ]);
  });

  test("an un-upgraded Computer's pre-Raft window vocabulary still ingests, normalized", async () => {
    const records: unknown[] = [];
    const method = createDaemonRuntimeUsageScanResultMethod({
      async putScan() {},
      async putResult(record) {
        records.push(record);
      },
      async read() {
        return { state: "missing" };
      },
    });
    const snapshot = {
      provider: "claude-code",
      primary: {
        status: "available",
        usedPercent: 25,
        windowDurationMinutes: 300,
        resetsAt: "2026-09-04T03:00:00.000Z",
      },
      secondary: {
        status: "rate-limited",
        usedPercent: 100,
        windowDurationMinutes: 10080,
        resetsAt: "2026-09-11T03:00:00.000Z",
      },
    };
    const payload = encodeDaemonRuntimeUsageScanResponse({
      protocolMajor: 1,
      requestId: "usage-legacy",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      provider: "claude-code",
      accepted: true,
      status: "available",
      snapshotJson: new TextEncoder().encode(JSON.stringify(snapshot)),
    });

    expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);
    expect(records).toEqual([
      {
        workspaceId: "workspace-1",
        computerId: "computer-1",
        provider: "claude-code",
        scanId: "usage-legacy",
        status: "available",
        message: undefined,
        snapshot: {
          provider: "claude-code",
          primary: {
            status: "ok",
            usedPercent: 25,
            windowDurationMinutes: 300,
            resetsAt: "2026-09-04T03:00:00.000Z",
          },
          secondary: {
            status: "limit_reached",
            usedPercent: 100,
            windowDurationMinutes: 10080,
            resetsAt: "2026-09-11T03:00:00.000Z",
          },
        },
        collectedAt: expect.any(String),
      },
    ]);
  });

  test("a snapshot's own collectedAt becomes the stored result's collectedAt", async () => {
    const records: unknown[] = [];
    const method = createDaemonRuntimeUsageScanResultMethod({
      async putScan() {},
      async putResult(record) {
        records.push(record);
      },
      async read() {
        return { state: "missing" };
      },
    });
    const snapshot = { provider: "codex", collectedAt: "2026-09-16T12:00:00.000Z" };
    const payload = encodeDaemonRuntimeUsageScanResponse({
      protocolMajor: 1,
      requestId: "usage-collected-at",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      provider: "codex",
      accepted: true,
      status: "available",
      snapshotJson: new TextEncoder().encode(JSON.stringify(snapshot)),
    });

    expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);
    expect(records).toMatchObject([{ collectedAt: "2026-09-16T12:00:00.000Z" }]);
  });

  test("an old Daemon's snapshot without collectedAt still gets a result timestamp", async () => {
    const records: unknown[] = [];
    const method = createDaemonRuntimeUsageScanResultMethod({
      async putScan() {},
      async putResult(record) {
        records.push(record);
      },
      async read() {
        return { state: "missing" };
      },
    });
    const payload = encodeDaemonRuntimeUsageScanResponse({
      protocolMajor: 1,
      requestId: "usage-no-collected-at",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      provider: "codex",
      accepted: true,
      status: "available",
      snapshotJson: new TextEncoder().encode(JSON.stringify({ provider: "codex" })),
    });

    expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);
    expect(records).toMatchObject([{ collectedAt: expect.any(String) }]);
  });

  test.each([
    ["is not a string", { provider: "codex", collectedAt: 1234 }],
    ["does not parse as a date", { provider: "codex", collectedAt: "not-a-date" }],
    ["has no asterisk", { provider: "codex", accountLabel: "me@gmail.com" }],
    ["is too long", { provider: "codex", accountLabel: `${"m".repeat(80)}*@gmail.com` }],
    ["has a control character", { provider: "codex", accountLabel: "me* *@gmail.com" }],
  ])(
    "rejects a Daemon usage snapshot whose collectedAt/accountLabel %s",
    async (_case, snapshot) => {
      const records: unknown[] = [];
      const method = createDaemonRuntimeUsageScanResultMethod({
        async putScan() {},
        async putResult(record) {
          records.push(record);
        },
        async read() {
          return { state: "missing" };
        },
      });
      const payload = encodeDaemonRuntimeUsageScanResponse({
        protocolMajor: 1,
        requestId: "usage-rejected",
        workspaceId: "workspace-1",
        computerId: "computer-1",
        provider: "codex",
        accepted: true,
        status: "available",
        snapshotJson: new TextEncoder().encode(JSON.stringify(snapshot)),
      });

      expect(await method(payload, { principal: principal() })).toEqual({
        code: 400,
        message: "invalid usage scan result",
      });
      expect(records).toEqual([]);
    },
  );

  test("accepts a masked accountLabel that keeps only the first characters of the local part", async () => {
    const records: unknown[] = [];
    const method = createDaemonRuntimeUsageScanResultMethod({
      async putScan() {},
      async putResult(record) {
        records.push(record);
      },
      async read() {
        return { state: "missing" };
      },
    });
    const snapshot = { provider: "codex", accountLabel: "me****@gmail.com" };
    const payload = encodeDaemonRuntimeUsageScanResponse({
      protocolMajor: 1,
      requestId: "usage-account-label",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      provider: "codex",
      accepted: true,
      status: "available",
      snapshotJson: new TextEncoder().encode(JSON.stringify(snapshot)),
    });

    expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);
    expect(records).toMatchObject([{ snapshot: { accountLabel: "me****@gmail.com" } }]);
  });

  test("preserves numeric credits and rejects invalid credit amounts at the usage boundary", async () => {
    const records: unknown[] = [];
    const method = createDaemonRuntimeUsageScanResultMethod({
      async putScan() {},
      async putResult(record) {
        records.push(record);
      },
      async read() {
        return { state: "missing" };
      },
    });
    const send = (creditUsage: unknown, includePrimary = true) =>
      method(
        encodeDaemonRuntimeUsageScanResponse({
          protocolMajor: 1,
          requestId: "usage-credits",
          workspaceId: "workspace-1",
          computerId: "computer-1",
          provider: "kiro",
          accepted: true,
          status: "available",
          snapshotJson: new TextEncoder().encode(
            JSON.stringify({
              provider: "kiro",
              creditUsage,
              ...(includePrimary
                ? {
                    primary: {
                      usedPercent: 2.55,
                      windowDurationMinutes: 43200,
                      resetsAt: "2026-10-01T00:00:00.000Z",
                    },
                  }
                : {}),
            }),
          ),
        }),
        { principal: principal() },
      );
    expect(await send({ used: 12.75, limit: 500, overage: 1.25 })).toBeInstanceOf(Uint8Array);
    expect(records).toMatchObject([
      { snapshot: { creditUsage: { used: 12.75, limit: 500, overage: 1.25 } } },
    ]);
    expect(await send({ used: 12.75, limit: 500, overage: 1.25 }, false)).toEqual({
      code: 400,
      message: "invalid usage scan result",
    });
    for (const creditUsage of [
      null,
      {},
      { used: -1, limit: 500, overage: 0 },
      { used: 501, limit: 500, overage: 0 },
      { used: 0, limit: 0, overage: 0 },
      { used: 0, limit: 500, overage: "1" },
    ]) {
      expect(await send(creditUsage)).toEqual({ code: 400, message: "invalid usage scan result" });
    }
    expect(records).toHaveLength(1);
  });

  test("rejects an invalid Daemon usage snapshot", async () => {
    const records: unknown[] = [];
    const method = createDaemonRuntimeUsageScanResultMethod({
      async putScan() {},
      async putResult(record) {
        records.push(record);
      },
      async read() {
        return { state: "missing" };
      },
    });
    const payload = encodeDaemonRuntimeUsageScanResponse({
      protocolMajor: 1,
      requestId: "usage-invalid",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      provider: "codex",
      accepted: true,
      status: "available",
      snapshotJson: new TextEncoder().encode(
        JSON.stringify({
          provider: "claude-code",
          primary: {
            usedPercent: 101,
            windowDurationMinutes: 300,
            resetsAt: "not-a-date",
          },
        }),
      ),
    });

    expect(await method(payload, { principal: principal() })).toEqual({
      code: 400,
      message: "invalid usage scan result",
    });
    expect(records).toEqual([]);
  });

  describe("Daemon model refresh result method", () => {
    test("accepts the Daemon's terminal reply for a refresh it performed", async () => {
      const method = createDaemonRuntimeProviderModelRefreshResultMethod();
      const payload = encodeDaemonRuntimeProviderModelRefreshResponse({
        protocolMajor: 1,
        requestId: "refresh-1",
        workspaceId: "workspace-1",
        computerId: "computer-1",
        accepted: true,
        status: "refreshed",
        catalogs: [{ provider: "codex", models: [] }],
      });

      expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);
    });

    test("accepts a refresh error reply", async () => {
      const method = createDaemonRuntimeProviderModelRefreshResultMethod();
      const payload = encodeDaemonRuntimeProviderModelRefreshResponse({
        protocolMajor: 1,
        requestId: "refresh-2",
        workspaceId: "workspace-1",
        computerId: "computer-1",
        accepted: false,
        status: "error",
        message: "probe exploded",
      });

      expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);
    });

    test("rejects a principal from another Computer", async () => {
      const method = createDaemonRuntimeProviderModelRefreshResultMethod();
      const payload = encodeDaemonRuntimeProviderModelRefreshResponse({
        protocolMajor: 1,
        requestId: "refresh-3",
        workspaceId: "workspace-1",
        computerId: "computer-2",
        accepted: true,
        status: "refreshed",
      });

      expect(await method(payload, { principal: principal() })).toEqual({
        code: 403,
        message: "daemon runtime identity is not authorized",
      });
    });

    test("rejects an invalid reply", async () => {
      const method = createDaemonRuntimeProviderModelRefreshResultMethod();
      const payload = encodeDaemonRuntimeProviderModelRefreshResponse({
        protocolMajor: 2,
        requestId: "",
        workspaceId: "workspace-1",
        computerId: "computer-1",
        accepted: true,
        status: "refreshed",
      });

      expect(await method(payload, { principal: principal() })).toEqual({
        code: 400,
        message: "invalid model refresh result",
      });
    });
  });

  test("composed protocol methods fail closed until persistence is wired", async () => {
    // Pass null so the assertion holds whether or not DATABASE_URL is set in
    // the developer's environment.
    const handler = createCentrifugoRpcHandler(null);
    const previous = process.env.COFORGE_CENTRIFUGO_PROXY_SECRET;
    process.env.COFORGE_CENTRIFUGO_PROXY_SECRET = "test-secret";
    const result = await handler.handleRequest(
      authorizedJson({
        method: "workspace:v1:list",
        b64data: "AA==",
        user: "user-1",
      }),
    );
    if (previous === undefined) delete process.env.COFORGE_CENTRIFUGO_PROXY_SECRET;
    expect(await result.json()).toEqual({
      error: {
        code: 503,
        message: "protocol method dependencies are unavailable",
      },
    });
  });

  test("does not expose Computer setup methods on the WSS composition", async () => {
    const handler = createCentrifugoRpcHandler(null);
    const previous = process.env.COFORGE_CENTRIFUGO_PROXY_SECRET;
    process.env.COFORGE_CENTRIFUGO_PROXY_SECRET = "test-secret";
    try {
      for (const method of ["workspace:v1:get", "computer:v1:register"]) {
        const result = await handler.handleRequest(authorizedJson({ method, b64data: "AA==" }));
        expect(await result.json()).toEqual({
          error: { code: 404, message: "unknown RPC method" },
        });
      }
    } finally {
      if (previous === undefined) delete process.env.COFORGE_CENTRIFUGO_PROXY_SECRET;
      else process.env.COFORGE_CENTRIFUGO_PROXY_SECRET = previous;
    }
  });

  test("rejects an unauthenticated internal proxy request", async () => {
    const handler = new CentrifugoRpcHandler({
      methods: { echo: () => new Uint8Array([1]) },
      authorizeProxyRequest: () => {
        throw new Error("not trusted");
      },
    });
    const result = await handler.handleRequest(json({ method: "echo", b64data: "AA==" }));
    expect(await result.json()).toEqual({
      error: { code: 403, message: "RPC request is not authorized" },
    });
  });

  test("maps a missing authenticated Centrifugo user to 401", async () => {
    const handler = new CentrifugoRpcHandler({
      methods: { echo: () => new Uint8Array([1]) },
      authenticateEnvelope: (request) => {
        if (!request.user) throw new CentrifugoRpcAuthenticationError();
        throw new Error("test callback must not authenticate this request");
      },
    });
    const result = await handler.handleRequest(json({ method: "echo", b64data: "AA==" }));
    expect(await result.json()).toEqual({
      error: { code: 401, message: "authentication required" },
    });
  });

  test("round trips binary payload and passes envelope metadata", async () => {
    const method: CentrifugoRpcMethod = (payload, metadata) => {
      expect([...payload]).toEqual([0, 255, 42]);
      expect(metadata.principal.userId).toBe("user-1");
      expect(metadata.client).toBe("connection-1");
      return payload;
    };
    const handler = new CentrifugoRpcHandler({ methods: { echo: method } });
    const result = await handler.handleRequest(
      json({
        method: "echo",
        user: "user-1",
        client: "connection-1",
        b64data: encoded("\0ÿ*"),
      }),
    );
    expect(await result.json()).toEqual({
      result: { b64data: encoded("\0ÿ*") },
    });
  });

  test("rejects unknown and malformed requests", async () => {
    const handler = new CentrifugoRpcHandler({ methods: {} });
    expect(
      await (await handler.handleRequest(json({ method: "nope", b64data: "AA==" }))).json(),
    ).toEqual({ error: { code: 404, message: "unknown RPC method" } });
    expect(
      await (
        await handler.handleRequest(new Request("http://handler", { method: "POST", body: "{" }))
      ).json(),
    ).toEqual({ error: { code: 400, message: "invalid RPC request" } });
  });

  test("maps handler errors without exposing secrets", async () => {
    const handler = new CentrifugoRpcHandler({
      methods: {
        boom: () => {
          throw new Error("token=super-secret");
        },
      },
    });
    const body = JSON.stringify(
      await (await handler.handleRequest(json({ method: "boom", b64data: "AA==" }))).json(),
    );
    expect(body).toBe('{"error":{"code":500,"message":"RPC method failed"}}');
    expect(body).not.toContain("super-secret");
  });
});
