import { Centrifuge } from "centrifuge/build/protobuf";
import type {
  ComputerRegisterRequest,
  ComputerRegisterResponse,
  ComputerRegisterTransport,
} from "@coforge/protocol";
import { WORKSPACE_GET_METHOD, WORKSPACE_PROTOCOL_MAJOR } from "@coforge/protocol";
import type { ComputerWorkspaceRpcTransport } from "./workspace/lookup";
import type { AccessibleWorkspace, Credential } from "./login";
import { RemoteRpcError, safeErrorDetail, setupError, TransportError } from "./errors";
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
      try {
        await new Promise<void>((resolve, reject) => {
          client.on("connected", resolve);
          client.on("error", reject);
          client.connect();
        });
      } catch (error) {
        throw new TransportError(
          `Could not connect to the CoForge RPC service: ${safeErrorDetail(error)}`,
          { cause: error },
        );
      }
      try {
        const response = await client.rpc(method, encodeComputerRegisterRequest(payload));
        return decodeComputerRegisterResponse(response.data);
      } catch (error) {
        const detail = error as { code?: string | number; requestId?: string; message?: string };
        throw new RemoteRpcError(
          method,
          detail.code,
          detail.requestId ?? payload.requestId,
          `The CoForge service rejected the Computer registration: ${safeErrorDetail(error)}`,
          { cause: error },
        );
      }
    } finally {
      client.disconnect();
    }
  }
}

export class CentrifugoWorkspaceRpcTransport implements ComputerWorkspaceRpcTransport {
  constructor(
    private readonly factory: CentrifugeFactory = defaultFactory,
    private readonly endpointForServer: (serverUrl: string) => string = centrifugoWebSocketEndpoint,
  ) {}

  async getBySlug(
    serverUrl: string,
    credential: Credential,
    slug: string,
  ): Promise<AccessibleWorkspace> {
    const requestId = crypto.randomUUID();
    const result = await this.call(
      this.endpointForServer(serverUrl),
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
        "workspace-lookup",
      );
    }
  }

  private async call(endpoint: string, token: string, method: string, payload: Uint8Array) {
    const client = this.factory(endpoint, token);
    try {
      try {
        await new Promise<void>((resolve, reject) => {
          client.on("connected", resolve);
          client.on("error", reject);
          client.connect();
        });
      } catch (error) {
        throw new TransportError(
          `Could not connect to the CoForge RPC service: ${safeErrorDetail(error)}`,
          { cause: error },
        );
      }
      try {
        return await client.rpc(method, payload);
      } catch (error) {
        const detail = error as { code?: string | number; requestId?: string };
        throw new RemoteRpcError(
          method,
          detail.code,
          detail.requestId,
          `The CoForge service rejected the Workspace lookup: ${safeErrorDetail(error)}`,
          { cause: error },
        );
      }
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

export function centrifugoWebSocketEndpoint(serverUrl: string, endpointOverride?: string): string {
  if (endpointOverride) return endpointOverride;
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/connection/websocket";
  return url.toString();
}

/**
 * E2E-only split endpoint. OAuth and HTTP workspace URLs remain serverUrl;
 * production has no override and keeps deriving WSS from that URL.
 */
export function resolveCentrifugoWebSocketEndpoint(serverUrl: string, env = Bun.env): string {
  const override =
    env.COFORGE_E2E_ALLOW_DEVICE_AUTH === "1" ? env.COFORGE_E2E_CENTRIFUGO_ENDPOINT : undefined;
  return centrifugoWebSocketEndpoint(serverUrl, override);
}

/**
 * Daemon's server connection endpoint. The Daemon connects through
 * Centrifugo's standard client WebSocket path, same as the browser;
 * Centrifugo's official Connect Proxy (not a URL prefix) distinguishes the
 * Daemon API key connect data from a browser's JWT. See docs/architecture.md's
 * "Standalone Centrifugo" section and ADR 0004.
 */
export function daemonConnectionEndpoint(serverUrl: string): string {
  return centrifugoWebSocketEndpoint(serverUrl);
}

/**
 * E2E-only split endpoint, mirroring `resolveCentrifugoWebSocketEndpoint`.
 * Locally and in E2E the Daemon's WSS target (Centrifugo's exposed port) and
 * `serverUrl` (the Web HTTP origin) are different hosts/ports because nothing
 * fronts them with one reverse proxy the way Caddy does in staging/production;
 * production has no override and keeps deriving WSS from `serverUrl`.
 */
export function resolveDaemonConnectionEndpoint(serverUrl: string, env = Bun.env): string {
  const override =
    env.COFORGE_E2E_ALLOW_DEVICE_AUTH === "1"
      ? env.COFORGE_E2E_DAEMON_CONNECTION_ENDPOINT
      : undefined;
  return override ?? daemonConnectionEndpoint(serverUrl);
}
