/** The deliberately small boundary between Centrifugo's HTTP proxy and Web. */
import {
  decodeComputerRegisterRequest,
  encodeComputerRegisterResponse,
} from "@coforge/protocol/codec";
import { ComputerRegistrationError } from "../computers/registration.server";
import { WorkspaceQueryError, WorkspaceQueryUseCase } from "../workspaces/query.server";
import { decodeWorkspaceGetRequest, decodeWorkspaceListRequest } from "@coforge/protocol/codec";
import { decodeWorkspaceWorkerReadyRequest, decodeAgentStartIntent } from "@coforge/protocol";
import { CloudAgentUseCase } from "../agents/cloud-agent.server";
import { decodeAgentMessageDeliveryAck } from "@coforge/protocol";
import { decodeAgentMessageRequest, encodeCloudAgentMessageResponse } from "@coforge/protocol";
import { SendDirectMessage } from "../conversations/direct-message.server";
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
      const messages = await repository.readMessages(
        metadata.principal.workspaceId,
        agentId,
        request.target,
      );
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

export const createWorkspaceWorkerReadyMethod =
  (recovery?: { recoverWorkspace(workspaceId: string): Promise<void> }): CentrifugoRpcMethod =>
  async (payload, metadata) => {
    const request = decodeWorkspaceWorkerReadyRequest(payload);
    if (
      !metadata.principal.userId ||
      metadata.principal.workspaceId !== request.workspaceId ||
      metadata.principal.computerId !== request.computerId
    )
      return { code: 403, message: "workspace worker identity is not authorized" };
    if (
      !request.workspaceId ||
      !request.computerId ||
      !request.workerInstanceId ||
      !request.requestId
    )
      return { code: 400, message: "invalid workspace worker ready request" };
    try {
      await recovery?.recoverWorkspace(request.workspaceId);
      return new Uint8Array();
    } catch {
      return { code: 503, message: "Agent start recovery failed" };
    }
  };

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
