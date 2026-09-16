import type {
  ComputerRegisterRequest,
  ComputerRegisterResponse,
  ComputerRegisterTransport,
} from "@lrm/coforge-sdk/internal";
import { WORKSPACE_GET_METHOD, WORKSPACE_PROTOCOL_MAJOR } from "@lrm/coforge-sdk/internal";
import {
  decodeComputerRegisterResponse,
  decodeWorkspaceGetResponse,
  encodeComputerRegisterRequest,
  encodeWorkspaceGetRequest,
} from "@lrm/coforge-sdk/internal/codec";
import { z } from "zod";
import { loginError, RemoteRpcError } from "./errors";
import type { AccessibleWorkspace, Credential } from "./login";
import type { ComputerWorkspaceRpcTransport } from "./workspace/lookup";

const rpcEnvelopeSchema = z.union([
  z.object({ result: z.object({ b64data: z.string() }) }),
  z.object({ error: z.object({ code: z.number(), message: z.string() }) }),
]);

type Fetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

async function callHttpRpc(
  fetchImplementation: Fetch,
  serverUrl: string,
  path: string,
  token: string,
  method: string,
  requestId: string,
  payload: Uint8Array,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImplementation(new URL(path, serverUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ b64data: payload.toBase64() }),
      redirect: "error",
    });
  } catch (error) {
    throw new RemoteRpcError(method, undefined, requestId, "The CoForge RPC request failed.", {
      cause: error,
    });
  }

  if (response.status === 401)
    throw loginError("AUTH_LOGIN_EXPIRED", "Your CoForge login has expired.");

  let envelope: z.infer<typeof rpcEnvelopeSchema>;
  try {
    envelope = rpcEnvelopeSchema.parse(await response.json());
  } catch (error) {
    throw new RemoteRpcError(
      method,
      response.status,
      requestId,
      "The CoForge RPC service returned an invalid response.",
      { cause: error },
    );
  }

  if ("error" in envelope) {
    if (envelope.error.code === 401)
      throw loginError("AUTH_LOGIN_EXPIRED", "Your CoForge login has expired.");
    throw new RemoteRpcError(
      method,
      envelope.error.code,
      requestId,
      `The CoForge RPC service rejected '${method}'.`,
    );
  }
  if (!response.ok)
    throw new RemoteRpcError(
      method,
      response.status,
      requestId,
      `The CoForge RPC service rejected '${method}'.`,
    );

  try {
    return Uint8Array.fromBase64(envelope.result.b64data);
  } catch (error) {
    throw new RemoteRpcError(
      method,
      response.status,
      requestId,
      "The CoForge RPC service returned invalid data.",
      { cause: error },
    );
  }
}

export class HttpComputerRegisterTransport implements ComputerRegisterTransport {
  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
    private readonly fetchImplementation: Fetch = fetch,
  ) {}

  async request(
    method: typeof import("@lrm/coforge-sdk/internal").COMPUTER_REGISTER_METHOD,
    payload: ComputerRegisterRequest,
  ): Promise<ComputerRegisterResponse> {
    const bytes = await callHttpRpc(
      this.fetchImplementation,
      this.serverUrl,
      "/api/computer/attach",
      this.token,
      method,
      payload.requestId,
      encodeComputerRegisterRequest(payload),
    );
    try {
      const response = decodeComputerRegisterResponse(bytes);
      if (response.requestId !== payload.requestId) throw new Error("request ID mismatch");
      return response;
    } catch (error) {
      throw new RemoteRpcError(
        method,
        undefined,
        payload.requestId,
        "Invalid registration response.",
        {
          cause: error,
        },
      );
    }
  }
}

export class HttpWorkspaceRpcTransport implements ComputerWorkspaceRpcTransport {
  constructor(private readonly fetchImplementation: Fetch = fetch) {}

  async getBySlug(
    serverUrl: string,
    credential: Credential,
    slug: string,
  ): Promise<AccessibleWorkspace> {
    const requestId = crypto.randomUUID();
    const bytes = await callHttpRpc(
      this.fetchImplementation,
      serverUrl,
      "/api/computer/workspace",
      credential.accessToken,
      WORKSPACE_GET_METHOD,
      requestId,
      encodeWorkspaceGetRequest({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId,
        workspaceSlug: slug,
      }),
    );
    try {
      const response = decodeWorkspaceGetResponse(bytes);
      if (response.protocolMajor !== WORKSPACE_PROTOCOL_MAJOR || response.requestId !== requestId)
        throw new Error("response correlation mismatch");
      return response.workspace;
    } catch (error) {
      throw new RemoteRpcError(
        WORKSPACE_GET_METHOD,
        undefined,
        requestId,
        "Invalid Workspace response.",
        {
          cause: error,
        },
      );
    }
  }
}

export function centrifugoWebSocketEndpoint(serverUrl: string, endpointOverride?: string): string {
  if (endpointOverride) return endpointOverride;
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/connection/websocket";
  return url.toString();
}

export function daemonConnectionEndpoint(serverUrl: string): string {
  return centrifugoWebSocketEndpoint(serverUrl);
}

export function resolveDaemonConnectionEndpoint(
  serverUrl: string,
  env = process.env.COFORGE_E2E_ALLOW_DEVICE_AUTH === "1" ? Bun.env : {},
): string {
  const override =
    env.COFORGE_E2E_ALLOW_DEVICE_AUTH === "1"
      ? env.COFORGE_E2E_DAEMON_CONNECTION_ENDPOINT
      : undefined;
  return override ?? daemonConnectionEndpoint(serverUrl);
}
