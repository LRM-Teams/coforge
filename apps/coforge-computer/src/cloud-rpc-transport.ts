import { Centrifuge } from "centrifuge/build/protobuf";
import type {
  ComputerRegisterRequest,
  ComputerRegisterResponse,
  ComputerRegisterTransport,
} from "@coforge/protocol";
import {
  encodeComputerRegisterRequest,
  decodeComputerRegisterResponse,
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

export function cloudWebSocketEndpoint(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/connection/websocket";
  return url.toString();
}
