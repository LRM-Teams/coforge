/** The deliberately small boundary between Centrifugo's HTTP proxy and Web. */
import {
  decodeComputerRegisterRequest,
  encodeComputerRegisterResponse,
} from "@coforge/protocol/codec";
import { ComputerRegistrationError } from "../computers/registration.server";
import { setComputerStatus } from "./computer-status.server";
import { WorkspaceQueryError, WorkspaceQueryUseCase } from "../workspaces/query.server";
import { decodeWorkspaceGetRequest, decodeWorkspaceListRequest } from "@coforge/protocol/codec";
import {
  decodeAgentStartIntent,
  decodeDaemonRuntimeCodeAgentsUpdateRequest,
  decodeDaemonRuntimeReadyRequest,
  decodeDaemonRuntimeUsageScanResponse,
  type CodeAgentModelCatalog,
  type RuntimeMetadata,
} from "@coforge/protocol";
import { getUsageCache, type UsageCache, type UsageSnapshot } from "./usage-cache.server";
import { CloudAgentUseCase } from "../agents/cloud-agent.server";
import { decodeAgentMessageDeliveryAck } from "@coforge/protocol";
import { decodeAgentMessageRequest, encodeCloudAgentMessageResponse } from "@coforge/protocol";
import { ReadDirectMessages, SendDirectMessage } from "../conversations/direct-message.server";
import { getMessageRequestIdempotency } from "../conversations/redis-message-request-idempotency.server";
import type { MessageRequestIdempotency } from "../conversations/message-request-idempotency.server";

export function createAgentDeliveryAckMethod(repository: {
  receiveDeliveryAck(input: {
    workspaceId: string;
    agentId: string;
    deliveryId: string;
    messageId: string;
    sequence: number;
  }): Promise<void>;
}): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const ack = decodeAgentMessageDeliveryAck(payload);
    if (!metadata.principal.userId || metadata.principal.workspaceId !== ack.workspaceId)
      return { code: 403, message: "workspace scope is not authorized" };
    try {
      await repository.receiveDeliveryAck(ack);
      return new Uint8Array();
    } catch {
      return { code: 403, message: "delivery acknowledgement is not authorized" };
    }
  };
}

export function createAgentStartMethod(useCase: CloudAgentUseCase): CentrifugoRpcMethod {
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
export function createAgentMessageMethod(
  repository: any,
  _centrifugo: any,
  operation: "read" | "send",
  authorization?: {
    canUseAgent(workspaceId: string, agentId: string, userId: string): Promise<boolean>;
  },
  idempotency?: MessageRequestIdempotency,
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const request = decodeAgentMessageRequest(payload);
    const agentId = request.agentId;
    if (!metadata.principal.userId || metadata.principal.workspaceId !== request.workspaceId)
      return { code: 403, message: "workspace scope is not authorized" };
    if (!metadata.principal.agentId || metadata.principal.agentId !== agentId)
      return { code: 403, message: "agent identity is not authorized" };
    if (
      !authorization ||
      !(await authorization.canUseAgent(request.workspaceId, agentId, metadata.principal.userId))
    )
      return { code: 403, message: "agent is not authorized" };
    if (!request.target.startsWith("@")) return { code: 400, message: "target must be @username" };
    if (operation === "read") {
      const messages = await new ReadDirectMessages(repository).execute({
        workspaceId: metadata.principal.workspaceId,
        agentId,
        target: request.target,
      });
      return encodeCloudAgentMessageResponse({
        protocolMajor: 1,
        requestId: request.requestId,
        accepted: true,
        attentionCount: 0,
        messages: messages.map((m: any) => ({ ...m, createdAt: m.createdAt.toISOString() })),
      });
    }
    const message = await new SendDirectMessage(
      repository,
      idempotency ?? getMessageRequestIdempotency(),
      _centrifugo,
    ).executeFromAgent({
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      agentId,
      target: request.target,
      body: request.body ?? "",
    });
    return encodeCloudAgentMessageResponse({
      protocolMajor: 1,
      requestId: request.requestId,
      accepted: true,
      attentionCount: 0,
      messageId: message.id,
      messages: [],
    });
  };
}

export const createDaemonRuntimeReadyMethod =
  (recovery?: {
    recoverWorkspace(workspaceId: string, computerId: string): Promise<void>;
  }): CentrifugoRpcMethod =>
  async (payload, metadata) => {
    const request = decodeDaemonRuntimeReadyRequest(payload);
    if (
      !metadata.principal.userId ||
      metadata.principal.workspaceId !== request.workspaceId ||
      metadata.principal.computerId !== request.computerId
    )
      return { code: 403, message: "daemon runtime identity is not authorized" };
    if (
      !request.workspaceId ||
      !request.computerId ||
      !request.workerInstanceId ||
      !request.requestId
    )
      return { code: 400, message: "invalid daemon runtime ready request" };
    try {
      await recovery?.recoverWorkspace(request.workspaceId, request.computerId);
      return new Uint8Array();
    } catch {
      return { code: 503, message: "Agent start recovery failed" };
    }
  };

export function createDaemonConnectionStatusMethod(): CentrifugoRpcMethod {
  return (payload, metadata) => {
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
    setComputerStatus(request.workspaceId, request.computerId, request.online);
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
    if (
      !metadata.principal.userId ||
      metadata.principal.workspaceId !== request.workspaceId ||
      metadata.principal.computerId !== request.computerId
    )
      return { code: 403, message: "daemon runtime identity is not authorized" };
    if (
      request.protocolMajor !== 1 ||
      !request.requestId ||
      request.runtimes.some(
        (runtime) =>
          runtime.kind !== "external" || runtime.provider === "pi" || !runtime.version.trim(),
      ) ||
      !validModelCatalogs(request.catalogs)
    )
      return { code: 400, message: "invalid Code Agent inventory" };
    try {
      await inventory.replace(
        { workspaceId: request.workspaceId, computerId: request.computerId },
        request.runtimes,
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
    if (
      !metadata.principal.userId ||
      metadata.principal.workspaceId !== response.workspaceId ||
      metadata.principal.computerId !== response.computerId
    )
      return { code: 403, message: "daemon runtime identity is not authorized" };
    if (response.protocolMajor !== 1 || !response.requestId || !response.provider)
      return { code: 400, message: "invalid usage scan result" };
    const snapshot = response.snapshotJson
      ? decodeUsageSnapshot(response.snapshotJson, response.provider)
      : undefined;
    if (response.snapshotJson && !snapshot)
      return { code: 400, message: "invalid usage scan result" };
    await (usageCache ?? getUsageCache()).put({
      workspaceId: response.workspaceId,
      computerId: response.computerId,
      provider: response.provider,
      scanId: response.requestId,
      status: usageStatus(response.status),
      message: response.message,
      snapshot,
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
  return {
    provider: expectedProvider,
    ...(typeof planType === "string" ? { planType } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(parsedCredits ? { credits: parsedCredits } : {}),
  };
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
  if (
    catalogs.length > 3 ||
    new Set(catalogs.map((catalog) => catalog.provider)).size !== catalogs.length
  )
    return false;
  return catalogs.every(
    (catalog) =>
      catalog.models.length <= 200 &&
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

export class CentrifugoRpcAuthenticationError extends Error {}

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
    request: import("@coforge/protocol").ComputerRegisterRequest,
    principal: { userId: string } | undefined,
  ) => Promise<import("@coforge/protocol").ComputerRegisterResponse>;
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

  async handleRequest(request: Request): Promise<Response> {
    try {
      await this.#authorizeProxyRequest?.(request);
    } catch {
      return errorResponse({ code: 403, message: "RPC request is not authorized" });
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
    if (typeof envelope.method !== "string" || !envelope.method || !payload)
      return errorResponse(errors.missing);
    const method = this.#methods.get(envelope.method);
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
      if (result instanceof Uint8Array) {
        let binary = "";
        for (const byte of result) binary += String.fromCharCode(byte);
        return response({ result: { b64data: btoa(binary) } });
      }
      return errorResponse(result);
    } catch (error) {
      if (error instanceof CentrifugoRpcAuthenticationError) {
        return errorResponse({ code: 401, message: "authentication required" });
      }
      return errorResponse(errors.failed);
    }
  }
}
