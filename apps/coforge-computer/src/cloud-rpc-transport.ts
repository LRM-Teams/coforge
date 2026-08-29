import { Centrifuge } from "centrifuge/build/protobuf";
import type {
  ComputerRegisterRequest,
  ComputerRegisterResponse,
  ComputerRegisterTransport,
} from "@coforge/protocol";
import { WORKSPACE_GET_METHOD, WORKSPACE_PROTOCOL_MAJOR } from "@coforge/protocol";
import type { ComputerWorkspaceRpcTransport } from "./workspace/lookup";
import type { AccessibleWorkspace, Credential } from "./login";
import { setupError } from "./errors";
import {
  encodeComputerRegisterRequest,
  decodeComputerRegisterResponse,
  encodeWorkspaceGetRequest,
  decodeWorkspaceGetResponse,
} from "@coforge/protocol/codec";

export interface CentrifugeClient {
  on(event: "connected", callback: () => void): void;
  on(event: "error", callback: (error: unknown) => void): void;
  connect(): void;
  disconnect(): void;
  rpc(method: string, data: Uint8Array): Promise<{ data: Uint8Array }>;
}

export type CentrifugeFactory = (endpoint: string, token: string) => CentrifugeClient;

const defaultFactory: CentrifugeFactory = (endpoint, token) =>
  new Centrifuge(endpoint, {
    token,
    websocket: globalThis.WebSocket,
  }) as unknown as CentrifugeClient;

export class CentrifugoComputerRegisterTransport implements ComputerRegisterTransport {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly factory: CentrifugeFactory = defaultFactory,
  ) {}

  async request(
    method: typeof import("@coforge/protocol").COMPUTER_REGISTER_METHOD,
    payload: ComputerRegisterRequest,
  ): Promise<ComputerRegisterResponse> {
    const client = this.factory(this.endpoint, this.token);
    try {
      await new Promise<void>((resolve, reject) => {
        client.on("connected", resolve);
        client.on("error", reject);
        client.connect();
      });
      const response = await client.rpc(method, encodeComputerRegisterRequest(payload));
      return decodeComputerRegisterResponse(response.data);
    } finally {
      client.disconnect();
    }
  }
}

export class CentrifugoWorkspaceRpcTransport implements ComputerWorkspaceRpcTransport {
  constructor(private readonly factory: CentrifugeFactory = defaultFactory) {}

  async getBySlug(
    serverUrl: string,
    credential: Credential,
    slug: string,
  ): Promise<AccessibleWorkspace> {
    const requestId = crypto.randomUUID();
    const result = await this.call(
      cloudWebSocketEndpoint(serverUrl),
      credential.accessToken,
      WORKSPACE_GET_METHOD,
      encodeWorkspaceGetRequest({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId,
        workspaceSlug: slug,
      }),
    );
    try {
      const response = decodeWorkspaceGetResponse(result.data);
      if (response.protocolMajor !== WORKSPACE_PROTOCOL_MAJOR || response.requestId !== requestId)
        throw new Error("invalid response");
      return response.workspace;
    } catch {
      throw setupError(
        "SETUP_WORKSPACE_NOT_FOUND",
        `Workspace '${slug}' was not found or is not accessible.`,
      );
    }
  }

  private async call(endpoint: string, token: string, method: string, payload: Uint8Array) {
    const client = this.factory(endpoint, token);
    try {
      await new Promise<void>((resolve, reject) => {
        client.on("connected", resolve);
        client.on("error", reject);
        client.connect();
      });
      return await client.rpc(method, payload);
    } finally {
      client.disconnect();
    }
  }
}

/** Kept as an explicit failure for callers that have not wired cloud RPC. */
export class UnconfiguredComputerWorkspaceRpcTransport implements ComputerWorkspaceRpcTransport {
  getBySlug(
    _serverUrl: string,
    _credential: Credential,
    _slug: string,
  ): Promise<AccessibleWorkspace> {
    return Promise.reject(
      setupError(
        "SETUP_WORKSPACE_RPC_UNAVAILABLE",
        "Workspace lookup RPC is not configured; no Workspace lookup method is approved in the current protocol.",
      ),
    );
  }
}

export function cloudWebSocketEndpoint(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/connection/websocket";
  return url.toString();
}
