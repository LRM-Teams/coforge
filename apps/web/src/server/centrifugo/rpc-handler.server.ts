/** The deliberately small boundary between Centrifugo's HTTP proxy and Web. */
import {
  decodeComputerRegisterRequest,
  encodeComputerRegisterResponse,
} from "@lrm/coforge-sdk/internal";
import { ComputerRegistrationError } from "../computers/registration.server";
import {
  handleRequestError,
  RequestAuthenticationError,
} from "../errors/request-error-handler.server";
import { getComputerStatusCache, type ComputerStatusCache } from "./computer-status.server";
import { WorkspaceQueryError, WorkspaceQueryUseCase } from "../workspaces/query.server";
import { decodeWorkspaceGetRequest, decodeWorkspaceListRequest } from "@lrm/coforge-sdk/internal";
import {
  decodeAgentStartIntent,
  decodeAgentStatus,
  decodeDaemonRuntimeCodeAgentsUpdateRequest,
  decodeDaemonRuntimeReadyRequest,
  decodeDaemonRuntimeUsageScanResponse,
  type CodeAgentModelCatalog,
  type RuntimeMetadata,
} from "@lrm/coforge-sdk/internal";
import { getUsageCache, type UsageCache, type UsageSnapshot } from "./usage-cache.server";
import { PublishAgentRuntimeControl } from "../agents/agent-runtime-control.server";
import { decodeAgentMessageDeliveryAck } from "@lrm/coforge-sdk/internal";
import {
  AGENT_STATUS_LEASE_MS,
  getAgentStatusCache,
  type AgentStatusCache,
} from "../agents/agent-status.server";
import {
  agentStatusChannel,
  encodeAgentStatusEvent,
} from "../../features/agents/agent-status-realtime";
import type { CentrifugoServerApi } from "./server-api.server";
import type { AgentDisplay } from "../agents/agent-display.server";
import {
  decodeReminderFireRequest,
  decodeReminderSnapshotRequest,
  encodeAgentReminderOperationResponse,
  decodeAgentReminderOperationRequest,
} from "@lrm/coforge-sdk/internal";
import type { Reminders } from "../reminders/reminders.server";
import type { ComputerRestartStore } from "../computers/computer-restart-store.server";
import {
  getComputerUpgradeStore,
  type RedisComputerUpgradeStore,
} from "../computers/computer-upgrade-store.server";
import { decodeComputerUpgradeResult } from "@lrm/coforge-sdk/internal";
import {
  computerObservationSchema,
  type ComputerObservation,
} from "../computers/computer-metadata.server";
export {
  createAgentSessionMethod,
  createAgentSessionInvalidateMethod,
} from "./agent-session-receiver.server";

export const createAgentReminderMethod =
  (reminders: Reminders): CentrifugoRpcMethod =>
  async (payload, metadata) => {
    let request;
    try {
      request = decodeAgentReminderOperationRequest(payload);
      if (
        metadata.principal.agentId !== request.agentId ||
        metadata.principal.workspaceId !== request.workspaceId ||
        metadata.principal.computerId !== request.computerId
      )
        throw new Error("reminder operation principal scope is not authorized");
      return encodeAgentReminderOperationResponse(
        await reminders.execute(request, metadata.principal.userId!),
      );
    } catch (error) {
      if (request)
        return encodeAgentReminderOperationResponse({
          protocolMajor: 1,
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          computerId: request.computerId,
          agentId: request.agentId,
          accepted: false,
          reason: error instanceof Error ? error.message : "reminder operation rejected",
          reminders: [],
          events: [],
        });
      return {
        code: 400,
        message: "invalid reminder operation request",
      };
    }
  };

export const createReminderFireMethod =
  (reminders: Reminders): CentrifugoRpcMethod =>
  async (payload, metadata) => {
    try {
      const request = decodeReminderFireRequest(payload);
      if (
        metadata.principal.workspaceId !== request.workspaceId ||
        metadata.principal.computerId !== request.computerId
      )
        throw new Error("reminder fire is not authorized");
      return await reminders.fireFromDaemon(request);
    } catch (error) {
      return {
        code: 403,
        message: error instanceof Error ? error.message : "reminder fire rejected",
      };
    }
  };

export const createReminderSnapshotMethod =
  (reminders: Reminders): CentrifugoRpcMethod =>
  async (payload, metadata) => {
    try {
      const request = decodeReminderSnapshotRequest(payload);
      if (
        metadata.principal.workspaceId !== request.workspaceId ||
        metadata.principal.computerId !== request.computerId
      )
        throw new Error("reminder snapshot is not authorized");
      return await reminders.snapshotForDaemon(request);
    } catch (error) {
      return {
        code: 403,
        message: error instanceof Error ? error.message : "reminder snapshot rejected",
      };
    }
  };

export function createAgentDeliveryAckMethod(repository: {
  receiveDeliveryAck(input: {
    workspaceId: string;
    computerId: string;
    agentId: string;
    deliveryId: string;
    messageId: string;
    sequence: number;
  }): Promise<void>;
}): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const ack = decodeAgentMessageDeliveryAck(payload);
    if (
      !metadata.principal.userId ||
      !metadata.principal.computerId ||
      metadata.principal.workspaceId !== ack.workspaceId
    )
      return { code: 403, message: "workspace scope is not authorized" };
    try {
      await repository.receiveDeliveryAck({
        ...ack,
        computerId: metadata.principal.computerId,
      });
      return new Uint8Array();
    } catch {
      return {
        code: 403,
        message: "delivery acknowledgement is not authorized",
      };
    }
  };
}

export function createAgentStartMethod(useCase: PublishAgentRuntimeControl): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    if (!metadata.principal.userId) return { code: 401, message: "authentication required" };
    try {
      await useCase.start(decodeAgentStartIntent(payload), metadata.principal.userId);
      return new Uint8Array();
    } catch (error) {
      return {
        code: 403,
        message: error instanceof Error ? error.message : "agent start rejected",
      };
    }
  };
}

export function createAgentStatusMethod(
  agents: {
    getById(id: string): Promise<{ workspaceId: string; computerId?: string } | undefined>;
  },
  statuses?: AgentStatusCache,
  events?: Pick<CentrifugoServerApi, "publish">,
  now = Date.now,
  display?: Pick<AgentDisplay, "observeStatus">,
  displayEvents?: Pick<CentrifugoServerApi, "publishJson">,
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const status = decodeAgentStatus(payload);
    const agent = await agents.getById(status.agentId);
    if (
      !metadata.principal.userId ||
      metadata.principal.workspaceId !== status.workspaceId ||
      metadata.principal.computerId !== status.computerId ||
      agent?.workspaceId !== status.workspaceId ||
      agent.computerId !== status.computerId
    )
      return { code: 403, message: "Agent status is not authorized" };
    const accepted = await (statuses ?? getAgentStatusCache()).put(status);
    if (!accepted) return new Uint8Array();
    // Persist the display process lease before optional realtime fan-out. A
    // Centrifugo publish failure must not leave an accepted status fact offline.
    let snapshot: Awaited<ReturnType<NonNullable<typeof display>["observeStatus"]>> | undefined;
    if (display) {
      try {
        snapshot = await display.observeStatus(status);
      } catch {
        // The optional display read model cannot reject an accepted process fact.
      }
    }
    try {
      if (events) {
        await events.publish(
          agentStatusChannel(status.workspaceId),
          encodeAgentStatusEvent({
            agentId: status.agentId,
            status: status.status,
            expiresAt: status.status === "active" ? now() + AGENT_STATUS_LEASE_MS : null,
            daemonInstanceId: status.daemonInstanceId,
            clientSeq: status.clientSeq,
            observedAtMs: status.observedAtMs,
          }),
        );
      }
      if (snapshot && displayEvents)
        await displayEvents.publishJson(agentStatusChannel(status.workspaceId), {
          type: "agent:display",
          ...snapshot,
        });
    } catch {
      // Realtime fan-out is best-effort once the process lease is stored.
    }
    return new Uint8Array();
  };
}

export const createDaemonRuntimeReadyMethod =
  (
    recovery?: {
      recoverWorkspace(
        workspaceId: string,
        computerId: string,
        runningAgentIds: readonly string[],
      ): Promise<void>;
    },
    restarts?: ComputerRestartStore,
    capabilities?: {
      record(workspaceId: string, computerId: string, values: readonly string[]): Promise<unknown>;
    },
    reminderRecovery?: { snapshotAssigned(workspaceId: string, computerId: string): Promise<void> },
    observe?: (
      scope: { workspaceId: string; computerId: string },
      metadata: ComputerObservation,
    ) => Promise<void>,
    upgrades?: RedisComputerUpgradeStore,
  ): CentrifugoRpcMethod =>
  async (payload, metadata) => {
    const request = decodeDaemonRuntimeReadyRequest(payload);
    const denied = requireDaemonPrincipal(metadata, request);
    if (denied) return denied;
    if (
      !request.workspaceId ||
      !request.computerId ||
      !request.workerInstanceId ||
      !request.daemonVersion?.trim() ||
      !request.recoveredRestartRequestIds ||
      new Set(request.recoveredRestartRequestIds).size !==
        request.recoveredRestartRequestIds.length ||
      !request.recoveredUpgradeRequestIds ||
      new Set(request.recoveredUpgradeRequestIds).size !==
        request.recoveredUpgradeRequestIds.length ||
      !request.requestId
    )
      return { code: 400, message: "invalid daemon runtime ready request" };
    const observation = computerObservationSchema.safeParse(request);
    if (!observation.success) return { code: 400, message: "invalid Computer metadata" };
    let stage = "restart_recovery";
    try {
      await restarts?.ready(
        { workspaceId: request.workspaceId, computerId: request.computerId },
        {
          workerInstanceId: request.workerInstanceId,
          daemonVersion: request.daemonVersion,
          startedAt: request.startedAt,
        },
        request.recoveredRestartRequestIds,
      );
      await capabilities?.record(
        request.workspaceId,
        request.computerId,
        request.capabilities ?? [],
      );
      const current = await restarts?.identity?.({
        workspaceId: request.workspaceId,
        computerId: request.computerId,
      });
      if (current && current.workerInstanceId !== request.workerInstanceId)
        return { code: 409, message: "daemon runtime was superseded" };
      await observe?.(
        { workspaceId: request.workspaceId, computerId: request.computerId },
        observation.data,
      );
      await recovery?.recoverWorkspace(
        request.workspaceId,
        request.computerId,
        request.runningAgentIds,
      );
      stage = "reminder_recovery";
      if (request.capabilities?.includes("reminder:v1"))
        await reminderRecovery?.snapshotAssigned(request.workspaceId, request.computerId);
      stage = "upgrade_recovery";
      if (upgrades && request.computerVersion?.trim())
        await upgrades.ready(
          { workspaceId: request.workspaceId, computerId: request.computerId },
          {
            workerInstanceId: request.workerInstanceId,
            computerVersion: request.computerVersion,
            daemonVersion: request.daemonVersion,
            startedAt: request.startedAt,
          },
          request.recoveredUpgradeRequestIds,
        );
      return new Uint8Array();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "daemon_ready.failed",
          stage,
          request_id: request.requestId,
          workspace_id: request.workspaceId,
          computer_id: request.computerId,
          error_type: error instanceof Error ? error.name : typeof error,
        }),
      );
      return { code: 503, message: "Agent start recovery failed" };
    }
  };

/**
 * The Daemon's terminal report for one upgrade operation. A reported failure settles the request
 * with its reason; a reported success is only ever corroborating evidence - the store still
 * requires the Computer's own new identity before calling an upgrade complete.
 */
export function createComputerUpgradeResultMethod(
  upgrades?: Pick<RedisComputerUpgradeStore, "reported">,
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    let result;
    try {
      result = decodeComputerUpgradeResult(payload);
    } catch {
      return { code: 400, message: "invalid Computer upgrade result" };
    }
    const denied = requireDaemonPrincipal(metadata, result);
    if (denied) return denied;
    if (result.protocolMajor !== 1 || !result.requestId)
      return { code: 400, message: "invalid Computer upgrade result" };
    try {
      await (upgrades ?? getComputerUpgradeStore()).reported(
        { workspaceId: result.workspaceId, computerId: result.computerId },
        {
          requestId: result.requestId,
          status: result.status,
          completedAtMs: result.completedAtMs,
          ...(result.version ? { version: result.version } : {}),
          ...(result.error ? { error: result.error } : {}),
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        },
      );
      // Acceptance is the acknowledgement: the Daemon drops its local record on this reply.
      return new Uint8Array();
    } catch {
      return { code: 503, message: "Computer upgrade result was not recorded" };
    }
  };
}

export function createDaemonConnectionStatusMethod(
  statusCache?: ComputerStatusCache,
  reminderCapabilities?: { refresh(workspaceId: string, computerId: string): Promise<void> },
  upgrades?: Pick<RedisComputerUpgradeStore, "touchIdentity">,
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const request = JSON.parse(new TextDecoder().decode(payload)) as {
      workspaceId?: string;
      computerId?: string;
      online?: boolean;
    };
    if (
      request.workspaceId !== metadata.principal.workspaceId ||
      request.computerId !== metadata.principal.computerId ||
      typeof request.online !== "boolean"
    )
      return { code: 403, message: "invalid daemon connection status" };
    await (statusCache ?? getComputerStatusCache()).put(
      { workspaceId: request.workspaceId, computerId: request.computerId },
      request.online,
    );
    if (request.online) {
      await reminderCapabilities?.refresh(request.workspaceId, request.computerId);
      // Transitional: identity keys are durable now (only `ready` writes one, with no expiry),
      // so this cannot create an identity for a Computer that never reported one. It only clears
      // a leftover 90s lease that a pre-durable-identity Web deploy left on an already-connected
      // Computer's identity key - Daemons do not reconnect just because Web deployed, so without
      // this the stale lease would otherwise sit there until the Daemon happened to reconnect.
      await upgrades?.touchIdentity({
        workspaceId: request.workspaceId,
        computerId: request.computerId,
      });
    }
    return new Uint8Array();
  };
}

export function createDaemonRuntimeCodeAgentsUpdateMethod(inventory: {
  replace(
    scope: { workspaceId: string; computerId: string },
    runtimes: RuntimeMetadata[],
    catalogs: CodeAgentModelCatalog[],
  ): Promise<unknown>;
}): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const request = decodeDaemonRuntimeCodeAgentsUpdateRequest(payload);
    const denied = requireDaemonPrincipal(metadata, request);
    if (denied) return denied;
    if (
      request.protocolMajor !== 1 ||
      !request.requestId ||
      (request.runtimes ?? []).some((runtime) => !runtime.version.trim()) ||
      !validModelCatalogs(request.catalogs)
    )
      return { code: 400, message: "invalid Code Agent inventory" };
    try {
      await inventory.replace(
        { workspaceId: request.workspaceId, computerId: request.computerId },
        request.runtimes ?? [],
        request.catalogs,
      );
      return new Uint8Array();
    } catch {
      return { code: 503, message: "Code Agent inventory update failed" };
    }
  };
}

export function createDaemonRuntimeUsageScanResultMethod(
  usageCache?: UsageCache,
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const response = decodeDaemonRuntimeUsageScanResponse(payload);
    const denied = requireDaemonPrincipal(metadata, response);
    if (denied) return denied;
    if (response.protocolMajor !== 1 || !response.requestId || !response.provider)
      return { code: 400, message: "invalid usage scan result" };
    const snapshot = response.snapshotJson
      ? decodeUsageSnapshot(response.snapshotJson, response.provider)
      : undefined;
    if (response.snapshotJson && !snapshot)
      return { code: 400, message: "invalid usage scan result" };
    await (usageCache ?? getUsageCache()).putResult({
      workspaceId: response.workspaceId,
      computerId: response.computerId,
      provider: response.provider,
      scanId: response.requestId,
      status: usageStatus(response.status),
      message: response.message,
      snapshot,
      // The snapshot's own observation time when the Computer reported one, otherwise this
      // result is only as fresh as the moment the server received it.
      collectedAt: snapshot?.collectedAt ?? new Date().toISOString(),
    });
    return new Uint8Array();
  };
}

function decodeUsageSnapshot(
  bytes: Uint8Array,
  expectedProvider: RuntimeMetadata["provider"],
): UsageSnapshot | undefined {
  if (bytes.byteLength > 16_384) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  const snapshot = record(value);
  if (!snapshot || snapshot.provider !== expectedProvider) return undefined;
  const planType = snapshot.planType;
  if (planType !== undefined && (typeof planType !== "string" || planType.length > 100))
    return undefined;
  const primary = usageWindow(snapshot.primary);
  const secondary = usageWindow(snapshot.secondary);
  if (
    (snapshot.primary !== undefined && !primary) ||
    (snapshot.secondary !== undefined && !secondary)
  )
    return undefined;
  const credits = record(snapshot.credits);
  const parsedCredits =
    credits && typeof credits.hasCredits === "boolean" && typeof credits.unlimited === "boolean"
      ? { hasCredits: credits.hasCredits, unlimited: credits.unlimited }
      : undefined;
  if (snapshot.credits !== undefined && !parsedCredits) return undefined;
  const amounts = record(snapshot.creditUsage);
  const creditUsage =
    amounts &&
    typeof amounts.used === "number" &&
    Number.isFinite(amounts.used) &&
    amounts.used >= 0 &&
    typeof amounts.limit === "number" &&
    Number.isFinite(amounts.limit) &&
    amounts.limit > 0 &&
    amounts.used <= amounts.limit &&
    typeof amounts.overage === "number" &&
    Number.isFinite(amounts.overage) &&
    amounts.overage >= 0
      ? { used: amounts.used, limit: amounts.limit, overage: amounts.overage }
      : undefined;
  if (snapshot.creditUsage !== undefined && (!creditUsage || !primary)) return undefined;
  const collectedAt = snapshot.collectedAt;
  if (
    collectedAt !== undefined &&
    (typeof collectedAt !== "string" || Number.isNaN(Date.parse(collectedAt)))
  )
    return undefined;
  const accountLabel = snapshot.accountLabel;
  if (accountLabel !== undefined && !isValidAccountLabel(accountLabel)) return undefined;
  return {
    provider: expectedProvider,
    ...(typeof planType === "string" ? { planType } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(parsedCredits ? { credits: parsedCredits } : {}),
    ...(creditUsage ? { creditUsage } : {}),
    ...(typeof collectedAt === "string" ? { collectedAt } : {}),
    ...(typeof accountLabel === "string" ? { accountLabel } : {}),
  };
}

/** A masked account email: at most 80 characters, no control characters, and containing at
 * least one `*` — a raw, unmasked address never passes this check. */
function isValidAccountLabel(value: unknown): value is string {
  // oxlint-disable-next-line no-control-regex
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 80 &&
    value.includes("*") &&
    !/[ -]/u.test(value)
  );
}

function usageWindow(value: unknown): UsageSnapshot["primary"] | undefined {
  const window = record(value);
  if (!window) return undefined;
  if (
    typeof window.windowDurationMinutes !== "number" ||
    !Number.isFinite(window.windowDurationMinutes) ||
    window.windowDurationMinutes <= 0 ||
    typeof window.resetsAt !== "string" ||
    window.resetsAt.length > 100 ||
    Number.isNaN(Date.parse(window.resetsAt)) ||
    (window.usedPercent !== undefined &&
      (typeof window.usedPercent !== "number" ||
        !Number.isFinite(window.usedPercent) ||
        window.usedPercent < 0 ||
        window.usedPercent > 100)) ||
    (window.status !== undefined &&
      window.status !== "available" &&
      window.status !== "rate-limited")
  )
    return undefined;
  return {
    windowDurationMinutes: window.windowDurationMinutes,
    resetsAt: window.resetsAt,
    ...(typeof window.usedPercent === "number" ? { usedPercent: window.usedPercent } : {}),
    ...(window.status === "available" || window.status === "rate-limited"
      ? { status: window.status }
      : {}),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function usageStatus(
  value: string,
): "available" | "unavailable" | "reauth" | "unsupported" | "error" {
  if (value === "available") return "available";
  if (value === "unavailable" || value === "reauth" || value === "unsupported" || value === "error")
    return value;
  return "error";
}

function validModelCatalogs(catalogs: CodeAgentModelCatalog[]): boolean {
  if (new Set(catalogs.map((catalog) => catalog.provider)).size !== catalogs.length) return false;
  return catalogs.every((catalog) =>
    catalog.models.every(
      (model) =>
        model.id.length > 0 &&
        model.id.length <= 200 &&
        model.displayName.length <= 200 &&
        model.description.length <= 2_000 &&
        model.modelProvider.length <= 100 &&
        model.defaultReasoning.length <= 100 &&
        model.reasoningEfforts.length <= 20 &&
        model.reasoningEfforts.every((effort) => effort.length > 0 && effort.length <= 100),
    ),
  );
}

export function createWorkspaceListMethod(useCase: WorkspaceQueryUseCase): CentrifugoRpcMethod {
  return (payload, metadata) =>
    useCase
      .list(
        decodeWorkspaceListRequest(payload),
        metadata.principal.userId ? { userId: metadata.principal.userId } : undefined,
      )
      .catch((error) => {
        if (error instanceof WorkspaceQueryError)
          return { code: error.code, message: error.message };
        throw error;
      });
}
export function createWorkspaceGetMethod(useCase: WorkspaceQueryUseCase): CentrifugoRpcMethod {
  return (payload, metadata) =>
    useCase
      .get(
        decodeWorkspaceGetRequest(payload),
        metadata.principal.userId ? { userId: metadata.principal.userId } : undefined,
      )
      .catch((error) => {
        if (error instanceof WorkspaceQueryError)
          return { code: error.code, message: error.message };
        throw error;
      });
}

export type CentrifugoRpcRequest = {
  client?: string;
  transport?: string;
  protocol?: string;
  encoding?: string;
  user?: string;
  method?: string;
  data?: unknown;
  b64data?: string;
  meta?: Record<string, unknown>;
};

export type CentrifugoRpcMetadata = {
  principal: AuthenticatedDaemonPrincipal;
  client?: string;
  transport?: string;
  protocol?: string;
  encoding?: string;
};

export type AuthenticatedDaemonPrincipal = {
  userId: string;
  workspaceId: string;
  computerId: string;
  agentId?: string;
};

export type CentrifugoRpcError = {
  code: number;
  message: string;
};

export class CentrifugoRpcAuthenticationError extends RequestAuthenticationError {}

export type CentrifugoRpcHandlerResult = Uint8Array | CentrifugoRpcError;
export type CentrifugoRpcMethod = (
  payload: Uint8Array,
  metadata: CentrifugoRpcMetadata,
) => CentrifugoRpcHandlerResult | Promise<CentrifugoRpcHandlerResult>;
export type CentrifugoRpcAuthenticate = (
  request: CentrifugoRpcRequest,
  context: Request,
) => AuthenticatedDaemonPrincipal | Promise<AuthenticatedDaemonPrincipal>;
export type CentrifugoProxyAuthorizer = (request: Request) => void | Promise<void>;

export function createComputerRegistrationMethod(useCase: {
  register: (
    request: import("@lrm/coforge-sdk/internal").ComputerRegisterRequest,
    principal: { userId: string } | undefined,
  ) => Promise<import("@lrm/coforge-sdk/internal").ComputerRegisterResponse>;
}): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    try {
      const request = decodeComputerRegisterRequest(payload);
      const result = await useCase.register(
        request,
        metadata.principal.userId ? { userId: metadata.principal.userId } : undefined,
      );
      return encodeComputerRegisterResponse(result);
    } catch (error) {
      if (error instanceof ComputerRegistrationError)
        return { code: error.code, message: error.message };
      throw error;
    }
  };
}

const errors = {
  malformed: { code: 400, message: "invalid RPC request" },
  missing: { code: 422, message: "RPC request is missing a method or payload" },
  unknown: { code: 404, message: "unknown RPC method" },
  failed: { code: 500, message: "RPC method failed" },
} as const;

/** A daemon RPC must come from the Computer it claims to speak for; the 403 to return if not. */
function requireDaemonPrincipal(
  metadata: CentrifugoRpcMetadata,
  claim: { workspaceId: string; computerId: string },
) {
  if (
    !metadata.principal.userId ||
    metadata.principal.workspaceId !== claim.workspaceId ||
    metadata.principal.computerId !== claim.computerId
  )
    return { code: 403, message: "daemon runtime identity is not authorized" };
  return undefined;
}

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(error: CentrifugoRpcError) {
  const safe = error.code >= 400 && error.code <= 1999 ? error : errors.failed;
  return response({ error: safe });
}

function decodePayload(request: CentrifugoRpcRequest) {
  if (typeof request.b64data === "string") {
    try {
      return Uint8Array.from(atob(request.b64data), (character) => character.charCodeAt(0));
    } catch {
      return undefined;
    }
  }
  if (Object.prototype.hasOwnProperty.call(request, "data")) {
    try {
      return new TextEncoder().encode(JSON.stringify(request.data));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export class CentrifugoRpcHandler {
  readonly #methods: ReadonlyMap<string, CentrifugoRpcMethod>;
  readonly #authenticateEnvelope?: CentrifugoRpcAuthenticate;

  constructor(options: {
    methods: ReadonlyMap<string, CentrifugoRpcMethod> | Record<string, CentrifugoRpcMethod>;
    authenticateEnvelope?: CentrifugoRpcAuthenticate;
    authorizeProxyRequest?: CentrifugoProxyAuthorizer;
  }) {
    this.#methods = new Map(
      options.methods instanceof Map ? options.methods : Object.entries(options.methods),
    );
    this.#authenticateEnvelope = options.authenticateEnvelope;
    this.#authorizeProxyRequest = options.authorizeProxyRequest;
  }

  readonly #authorizeProxyRequest?: CentrifugoProxyAuthorizer;

  async handleRequest(request: Request, fixedMethod?: string): Promise<Response> {
    try {
      await this.#authorizeProxyRequest?.(request);
    } catch {
      return errorResponse({
        code: 403,
        message: "RPC request is not authorized",
      });
    }
    let envelope: CentrifugoRpcRequest;
    try {
      envelope = await request.json();
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
        throw new Error("not an object");
    } catch {
      return errorResponse(errors.malformed);
    }

    const payload = decodePayload(envelope);
    const requestedMethod = fixedMethod ?? envelope.method;
    if (typeof requestedMethod !== "string" || !requestedMethod || !payload)
      return errorResponse(errors.missing);
    const method = this.#methods.get(requestedMethod);
    if (!method) return errorResponse(errors.unknown);

    try {
      const principal =
        (await this.#authenticateEnvelope?.(envelope, request)) ??
        (typeof envelope.user === "string"
          ? { userId: envelope.user, workspaceId: "", computerId: "" }
          : { userId: "", workspaceId: "", computerId: "" });
      const result = await method(payload, {
        principal,
        client: envelope.client,
        transport: envelope.transport,
        protocol: envelope.protocol,
        encoding: envelope.encoding,
      });
      if (result instanceof Uint8Array)
        return response({ result: { b64data: Buffer.from(result).toString("base64") } });
      return errorResponse(result);
    } catch (error) {
      return errorResponse(handleRequestError(error));
    }
  }
}
