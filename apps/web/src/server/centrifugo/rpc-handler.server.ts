/** The deliberately small boundary between Centrifugo's HTTP proxy and Web. */
import {
  decodeComputerRegisterRequest,
  encodeComputerRegisterResponse,
} from "@coforge/protocol/codec";
import { ComputerRegistrationError } from "../computers/registration.server";
import { WorkspaceQueryError, WorkspaceQueryUseCase } from "../workspaces/query.server";
import { decodeWorkspaceGetRequest, decodeWorkspaceListRequest } from "@coforge/protocol/codec";
import { decodeWorkspaceWorkerReadyRequest } from "@coforge/protocol";

export const createWorkspaceWorkerReadyMethod = (): CentrifugoRpcMethod => (payload, metadata) => {
  const request = decodeWorkspaceWorkerReadyRequest(payload);
  const meta = metadata.meta;
  if (
    !metadata.user ||
    meta.workspace_id !== request.workspaceId ||
    meta.computer_id !== request.computerId
  )
    return { code: 403, message: "workspace worker identity is not authorized" };
  if (
    !request.workspaceId ||
    !request.computerId ||
    !request.workerInstanceId ||
    !request.requestId
  )
    return { code: 400, message: "invalid workspace worker ready request" };
  return new Uint8Array();
};

export function createWorkspaceListMethod(useCase: WorkspaceQueryUseCase): CentrifugoRpcMethod {
  return (payload, metadata) =>
    useCase
      .list(
        decodeWorkspaceListRequest(payload),
        metadata.user ? { userId: metadata.user } : undefined,
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
        metadata.user ? { userId: metadata.user } : undefined,
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
  user: string;
  client?: string;
  transport?: string;
  protocol?: string;
  encoding?: string;
  meta: Readonly<Record<string, unknown>>;
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
export type CentrifugoRpcAuthenticate = (request: CentrifugoRpcRequest) => void | Promise<void>;
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
        metadata.user ? { userId: metadata.user } : undefined,
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
      await this.#authenticateEnvelope?.(envelope);
      const result = await method(payload, {
        user: typeof envelope.user === "string" ? envelope.user : "",
        client: envelope.client,
        transport: envelope.transport,
        protocol: envelope.protocol,
        encoding: envelope.encoding,
        meta: envelope.meta ?? {},
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
