import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { getLogger } from "@logtape/logtape";
import {
  decodeDaemonHandshakeRequest,
  decodeDaemonCommandRequest,
  decodeDaemonRuntimeConfigureRequest,
  encodeDaemonRuntimeConfigureResponse,
  encodeDaemonHandshakeResponse,
  encodeDaemonCommandResponse,
  frameLocalRpc,
  readLocalRpcFrames,
  decodeLocalRpcRequest,
  encodeLocalRpcResponse,
  LOCAL_RPC_METHODS,
  decodeLocalAgentMessageRequest,
  encodeAgentMessageResponse,
  decodeLocalInboxRequest,
  encodeInboxResponse,
  decodeUsageScanRequest,
  encodeUsageScanResponse,
  type UsageScanResponse,
  type AgentMessageResponse,
  type InboxResponse,
  type LocalAgentMessageRequest,
  type LocalInboxRequest,
  type DaemonCommandRequest,
  type ManagedRuntimeIdentity,
} from "@lrm/coforge-sdk/internal";
import type { DaemonConfig } from "./daemon-runtime/runtime";
import type { DaemonCredentialStore } from "./credentials/credential-store";
import type { DaemonConfigStore } from "./persistence/daemon-config";
import { COFORGE_DAEMON_SERVER_URL } from "./connection/built-server";

const logger = getLogger(["coforge", "daemon", "local-rpc"]);

export type DaemonLocalRpcServer = {
  close(): Promise<void>;
};

type DaemonRuntimePort = Partial<{
  configure(connection: DaemonConfig): Promise<void>;
  start(): Promise<void>;
  stopAll(): Promise<void>;
  restart(): Promise<void>;
  agentMessage(context: string, request: LocalAgentMessageRequest): Promise<unknown>;
  inbox(context: string, request: LocalInboxRequest): Promise<InboxResponse>;
  scanUsage(provider: string): Promise<UsageScanResponse>;
  command(method: string, request: DaemonCommandRequest): Promise<ManagedRuntimeIdentity[]>;
}>;

type LocalRpcConfigStore = Pick<DaemonConfigStore, "load" | "save" | "clear"> &
  Partial<Pick<DaemonConfigStore, "assertExpectedServer">>;

type LocalRpcServerInput = {
  socketPath: string;
  serverUrl?: string;
  validateCredential: (credential: string) => boolean | Promise<boolean>;
  runtime: DaemonRuntimePort;
  credentials: DaemonCredentialStore;
  version?: string;
  configStore?: LocalRpcConfigStore;
};

const LIFECYCLE_METHODS: ReadonlySet<string> = new Set([
  LOCAL_RPC_METHODS.START,
  LOCAL_RPC_METHODS.STOP,
  LOCAL_RPC_METHODS.RESTART,
  LOCAL_RPC_METHODS.SNAPSHOT,
  LOCAL_RPC_METHODS.PAUSE,
  LOCAL_RPC_METHODS.RESUME,
  LOCAL_RPC_METHODS.UPGRADE,
  LOCAL_RPC_METHODS.UPGRADE_ACKNOWLEDGE,
]);

export async function startDaemonLocalRpcServer(
  input: LocalRpcServerInput,
): Promise<DaemonLocalRpcServer> {
  await mkdir(dirname(input.socketPath), { recursive: true, mode: 0o700 });
  await rm(input.socketPath, { force: true });
  const dispatcher = new LocalRpcDispatcher(input);
  const server = Bun.listen<LocalSocketData>({
    unix: input.socketPath,
    socket: {
      open(socket) {
        socket.data = { buffer: new Uint8Array(), processing: Promise.resolve() };
      },
      data(socket, chunk) {
        socket.data.processing = socket.data.processing
          .then(() => dispatcher.receive(socket, chunk))
          .catch((error: unknown) => {
            logger.error("Local RPC connection failed", {
              event: "daemon.local_rpc.connection_failed",
              error: error instanceof Error ? error.message : String(error),
              outcome: "error",
            });
            socket.end();
          });
      },
    },
  });
  await chmod(input.socketPath, 0o600);
  return {
    close: async () => {
      server.stop(true);
      await rm(input.socketPath, { force: true });
    },
  };
}

type LocalSocketData = { buffer: Uint8Array; processing: Promise<void> };

/** Decodes framed local RPC requests and answers each one with a framed response payload. */
class LocalRpcDispatcher {
  readonly #daemonId = crypto.randomUUID();
  readonly #serverUrl: string;
  readonly #handlers: Record<string, (payload: Uint8Array) => Promise<Uint8Array>>;

  constructor(private readonly input: LocalRpcServerInput) {
    this.#serverUrl = input.serverUrl ?? COFORGE_DAEMON_SERVER_URL;
    this.#handlers = {
      [LOCAL_RPC_METHODS.HANDSHAKE]: (payload) => this.#handshake(payload),
      [LOCAL_RPC_METHODS.AGENT_MESSAGE]: (payload) => this.#agentMessage(payload),
      [LOCAL_RPC_METHODS.AGENT_INBOX]: (payload) => this.#inbox(payload),
      [LOCAL_RPC_METHODS.USAGE_SCAN]: (payload) => this.#usageScan(payload),
      [LOCAL_RPC_METHODS.CONFIGURE]: (payload) => this.#configure(payload),
    };
  }

  async receive(socket: Bun.Socket<LocalSocketData>, chunk: Uint8Array): Promise<void> {
    const next = new Uint8Array(socket.data.buffer.byteLength + chunk.byteLength);
    next.set(socket.data.buffer);
    next.set(chunk, socket.data.buffer.byteLength);
    const parsed = readLocalRpcFrames(next);
    socket.data.buffer = parsed.remainder;
    for (const frame of parsed.frames) {
      // Captured outside the try so a failure can still say which request failed, including when
      // the frame itself is what could not be decoded.
      let method = "unknown";
      try {
        const envelope = decodeLocalRpcRequest(frame);
        method = envelope.method;
        const handler = LIFECYCLE_METHODS.has(method)
          ? (payload: Uint8Array) => this.#lifecycle(method, payload)
          : this.#handlers[method];
        if (!handler) {
          logger.warn("Local RPC request used an unknown method", {
            event: "daemon.local_rpc.unknown_method",
            method,
            outcome: "rejected",
          });
          socket.end();
          return;
        }
        const payload = await handler(envelope.payload);
        socket.write(frameLocalRpc(encodeLocalRpcResponse({ method, payload })));
      } catch (error) {
        // Closing the connection is the right response - the caller is a local process that will
        // retry - but doing it silently was not. Every guard in the handlers above (a server-origin
        // mismatch, a runtime that refuses to configure, a malformed frame) reached the caller as an
        // indistinguishable closed socket, and `coforge-computer setup` could only report that the
        // Daemon "could not be started" without ever being able to say why. This line is the only
        // place that knows.
        logger.error("Local RPC request failed", {
          event: "daemon.local_rpc.failed",
          method,
          error: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : undefined,
          outcome: "error",
        });
        socket.end();
        return;
      }
    }
  }

  async #handshake(payload: Uint8Array): Promise<Uint8Array> {
    const request = decodeDaemonHandshakeRequest(payload);
    return encodeDaemonHandshakeResponse({
      protocolMajor: 1,
      requestId: request.requestId,
      daemonId: this.#daemonId,
      accepted: request.protocolMajor === 1 && request.requestId.length > 0,
      serverUrl: this.#serverUrl,
      version: this.input.version,
      processId: process.pid,
    });
  }

  async #agentMessage(payload: Uint8Array): Promise<Uint8Array> {
    const request = decodeLocalAgentMessageRequest(payload);
    const { runtime } = this.input;
    if (!request.context || !runtime.agentMessage)
      throw new Error("agent local context is not bound");
    const result = await runtime.agentMessage(request.context, request);
    return encodeAgentMessageResponse(result as AgentMessageResponse);
  }

  async #inbox(payload: Uint8Array): Promise<Uint8Array> {
    const request = decodeLocalInboxRequest(payload);
    const { runtime } = this.input;
    if (!request.context || !request.requestId || !runtime.inbox)
      throw new Error("agent local context is not bound");
    return encodeInboxResponse(await runtime.inbox(request.context, request));
  }

  async #usageScan(payload: Uint8Array): Promise<Uint8Array> {
    const request = decodeUsageScanRequest(payload);
    if (request.protocolMajor !== 1 || !request.requestId || !request.provider)
      throw new Error("invalid usage scan request");
    const result = await this.input.runtime.scanUsage?.(request.provider);
    if (!result) throw new Error("usage scanning is unavailable");
    return encodeUsageScanResponse({ ...result, requestId: request.requestId, protocolMajor: 1 });
  }

  /** Rejects requests addressed to a server other than the one this daemon build embeds. */
  #assertOwnServer(expectedServerUrl: string, what: string): void {
    this.input.configStore?.assertExpectedServer?.(expectedServerUrl);
    if (new URL(expectedServerUrl).origin !== new URL(this.#serverUrl).origin)
      throw new Error(`Daemon ${what} server does not match this daemon build`);
  }

  async #lifecycle(method: string, payload: Uint8Array): Promise<Uint8Array> {
    const request = decodeDaemonCommandRequest(payload);
    this.#assertOwnServer(request.expectedServerUrl, "request");
    const valid = request.protocolMajor === 1 && request.requestId.length > 0;
    const runtimes = valid ? await this.#runLifecycle(method, request) : undefined;
    return encodeDaemonCommandResponse({
      protocolMajor: 1,
      requestId: request.requestId,
      accepted: valid,
      runtimes,
    });
  }

  async #runLifecycle(
    method: string,
    request: DaemonCommandRequest,
  ): Promise<ManagedRuntimeIdentity[] | undefined> {
    const { runtime } = this.input;
    if (runtime.command) return runtime.command(method, request);
    if (request.workspaceId) throw new Error("scoped lifecycle requires supervisor");
    const unscoped: Partial<Record<string, (() => Promise<void>) | undefined>> = {
      [LOCAL_RPC_METHODS.START]: runtime.start,
      [LOCAL_RPC_METHODS.STOP]: runtime.stopAll,
      [LOCAL_RPC_METHODS.RESTART]: runtime.restart,
    };
    const run = unscoped[method];
    if (!run) throw new Error("daemon command is unavailable");
    await run.call(runtime);
    return undefined;
  }

  async #configure(payload: Uint8Array): Promise<Uint8Array> {
    const request = decodeDaemonRuntimeConfigureRequest(payload);
    this.#assertOwnServer(request.expectedServerUrl, "request");
    if (request.serverHttpUrl) this.#assertOwnServer(request.serverHttpUrl, "configuration");
    const valid =
      request.protocolMajor === 1 &&
      [request.workspaceId, request.computerId, request.workspaceRoot, request.daemonApiKey].every(
        Boolean,
      ) &&
      (await this.input.validateCredential(request.daemonApiKey));
    if (valid) await this.#adoptConfiguration(request);
    return encodeDaemonRuntimeConfigureResponse({
      protocolMajor: 1,
      requestId: request.requestId,
      accepted: valid,
    });
  }

  /** Saves the credential and connection, rolling both back if the runtime refuses them. */
  async #adoptConfiguration(request: {
    workspaceId: string;
    computerId: string;
    workspaceRoot: string;
    daemonApiKey: string;
  }): Promise<void> {
    const { runtime, credentials, configStore } = this.input;
    const { workspaceId, computerId } = request;
    const saved = await credentials.load(workspaceId, computerId);
    const previousConfig = await configStore?.load();
    const credentialChanged = saved !== request.daemonApiKey;
    if (credentialChanged) await credentials.save(workspaceId, computerId, request.daemonApiKey);
    const connection = {
      workspaceId,
      computerId,
      workspaceRoot: request.workspaceRoot,
      serverHttpUrl: this.#serverUrl,
    };
    try {
      if (!runtime.configure) throw new Error("daemon configuration is unavailable");
      await runtime.configure(connection);
      await configStore?.save(connection);
    } catch (error) {
      if (credentialChanged) {
        if (saved !== null) await credentials.save(workspaceId, computerId, saved);
        else await credentials.delete(workspaceId, computerId);
      }
      // Preserve the previous active config, if any. Never remove local state on failure.
      if (configStore) {
        if (previousConfig) await configStore.save(previousConfig);
        else await configStore.clear();
      }
      throw error;
    }
  }
}
