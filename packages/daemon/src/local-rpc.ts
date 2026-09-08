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
} from "@coforge/protocol";
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

export async function startDaemonLocalRpcServer(input: {
  socketPath: string;
  serverUrl?: string;
  validateCredential: (credential: string) => boolean | Promise<boolean>;
  runtime: DaemonRuntimePort;
  credentials: DaemonCredentialStore;
  version?: string;
  configStore?: Pick<DaemonConfigStore, "load" | "save" | "clear"> &
    Partial<Pick<DaemonConfigStore, "assertExpectedServer">>;
}): Promise<DaemonLocalRpcServer> {
  await mkdir(dirname(input.socketPath), { recursive: true, mode: 0o700 });
  await rm(input.socketPath, { force: true });
  const daemonId = crypto.randomUUID();
  const server = Bun.listen<LocalSocketData>({
    unix: input.socketPath,
    socket: {
      open(socket) {
        socket.data = { buffer: new Uint8Array(), processing: Promise.resolve() };
      },
      data(socket, chunk) {
        socket.data.processing = socket.data.processing
          .then(() =>
            handleConnection(
              socket,
              chunk,
              daemonId,
              input.serverUrl ?? COFORGE_DAEMON_SERVER_URL,
              input.validateCredential,
              input.runtime,
              input.credentials,
              input.configStore,
              input.version,
            ),
          )
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

async function handleConnection(
  socket: Bun.Socket<LocalSocketData>,
  chunk: Uint8Array,
  daemonId: string,
  serverUrl: string,
  validateCredential: (credential: string) => boolean | Promise<boolean>,
  runtime: DaemonRuntimePort,
  credentials: DaemonCredentialStore,
  configStore:
    | (Pick<DaemonConfigStore, "load" | "save" | "clear"> &
        Partial<Pick<DaemonConfigStore, "assertExpectedServer">>)
    | undefined,
  version?: string,
): Promise<void> {
  const next = new Uint8Array(socket.data.buffer.byteLength + chunk.byteLength);
  next.set(socket.data.buffer);
  next.set(chunk, socket.data.buffer.byteLength);
  socket.data.buffer = next;
  const parsed = readLocalRpcFrames(socket.data.buffer);
  socket.data.buffer = parsed.remainder;
  for (const frame of parsed.frames) {
    // Captured outside the try so a failure can still say which request failed, including when
    // the frame itself is what could not be decoded.
    let currentMethod = "unknown";
    try {
      const envelope = decodeLocalRpcRequest(frame);
      currentMethod = envelope.method;
      if (envelope.method === LOCAL_RPC_METHODS.HANDSHAKE) {
        const request = decodeDaemonHandshakeRequest(envelope.payload);
        const valid = request.protocolMajor === 1 && request.requestId.length > 0;
        socket.write(
          frameLocalRpc(
            encodeLocalRpcResponse({
              method: LOCAL_RPC_METHODS.HANDSHAKE,
              payload: encodeDaemonHandshakeResponse({
                protocolMajor: 1,
                requestId: request.requestId,
                daemonId,
                accepted: valid,
                serverUrl,
                version,
                processId: process.pid,
              }),
            }),
          ),
        );
      } else if (envelope.method === LOCAL_RPC_METHODS.AGENT_MESSAGE) {
        const request = decodeLocalAgentMessageRequest(envelope.payload);
        if (!request.context || !runtime.agentMessage)
          throw new Error("agent local context is not bound");
        const result = await runtime.agentMessage(request.context, request);
        socket.write(
          frameLocalRpc(
            encodeLocalRpcResponse({
              method: envelope.method,
              payload: encodeAgentMessageResponse(result as AgentMessageResponse),
            }),
          ),
        );
      } else if (envelope.method === LOCAL_RPC_METHODS.AGENT_INBOX) {
        const request = decodeLocalInboxRequest(envelope.payload);
        if (!request.context || !request.requestId || !runtime.inbox)
          throw new Error("agent local context is not bound");
        const result = await runtime.inbox(request.context, request);
        socket.write(
          frameLocalRpc(
            encodeLocalRpcResponse({
              method: envelope.method,
              payload: encodeInboxResponse(result),
            }),
          ),
        );
      } else if (envelope.method === LOCAL_RPC_METHODS.USAGE_SCAN) {
        const request = decodeUsageScanRequest(envelope.payload);
        if (request.protocolMajor !== 1 || !request.requestId || !request.provider)
          throw new Error("invalid usage scan request");
        const result = await runtime.scanUsage?.(request.provider);
        if (!result) throw new Error("usage scanning is unavailable");
        socket.write(
          frameLocalRpc(
            encodeLocalRpcResponse({
              method: envelope.method,
              payload: encodeUsageScanResponse({
                ...result,
                requestId: request.requestId,
                protocolMajor: 1,
              }),
            }),
          ),
        );
      } else if (
        envelope.method === LOCAL_RPC_METHODS.START ||
        envelope.method === LOCAL_RPC_METHODS.STOP ||
        envelope.method === LOCAL_RPC_METHODS.RESTART ||
        envelope.method === LOCAL_RPC_METHODS.SNAPSHOT ||
        envelope.method === LOCAL_RPC_METHODS.PAUSE ||
        envelope.method === LOCAL_RPC_METHODS.RESUME
      ) {
        const request = decodeDaemonCommandRequest(envelope.payload);
        configStore?.assertExpectedServer?.(request.expectedServerUrl);
        if (new URL(request.expectedServerUrl).origin !== new URL(serverUrl).origin)
          throw new Error("Daemon request server does not match this daemon build");
        const valid = request.protocolMajor === 1 && request.requestId.length > 0;
        let runtimes: ManagedRuntimeIdentity[] | undefined;
        if (valid) {
          if (runtime.command) runtimes = await runtime.command(envelope.method, request);
          else if (request.workspaceId) throw new Error("scoped lifecycle requires supervisor");
          else if (envelope.method === LOCAL_RPC_METHODS.START && runtime.start)
            await runtime.start();
          else if (envelope.method === LOCAL_RPC_METHODS.STOP && runtime.stopAll)
            await runtime.stopAll();
          else if (envelope.method === LOCAL_RPC_METHODS.RESTART && runtime.restart)
            await runtime.restart();
          else throw new Error("daemon command is unavailable");
        }
        socket.write(
          frameLocalRpc(
            encodeLocalRpcResponse({
              method: envelope.method,
              payload: encodeDaemonCommandResponse({
                protocolMajor: 1,
                requestId: request.requestId,
                accepted: valid,
                runtimes,
              }),
            }),
          ),
        );
      } else if (envelope.method === LOCAL_RPC_METHODS.CONFIGURE) {
        const request = decodeDaemonRuntimeConfigureRequest(envelope.payload);
        configStore?.assertExpectedServer?.(request.expectedServerUrl);
        if (new URL(request.expectedServerUrl).origin !== new URL(serverUrl).origin) {
          throw new Error("Daemon request server does not match this daemon build");
        }
        if (
          request.serverHttpUrl &&
          new URL(request.serverHttpUrl).origin !== new URL(serverUrl).origin
        )
          throw new Error("Daemon configuration server does not match this daemon build");
        const valid =
          request.protocolMajor === 1 &&
          [
            request.workspaceId,
            request.computerId,
            request.workspaceRoot,
            request.daemonApiKey,
          ].every(Boolean) &&
          (await validateCredential(request.daemonApiKey));
        if (valid) {
          const saved = await credentials.load(request.workspaceId, request.computerId);
          const previousConfig = await configStore?.load();
          const credentialChanged = saved !== request.daemonApiKey;
          if (credentialChanged) {
            await credentials.save(request.workspaceId, request.computerId, request.daemonApiKey);
          }
          const connection = {
            workspaceId: request.workspaceId,
            computerId: request.computerId,
            workspaceRoot: request.workspaceRoot,
            serverHttpUrl: serverUrl,
          };
          try {
            if (runtime.configure) await runtime.configure(connection);
            else throw new Error("daemon configuration is unavailable");
            await configStore?.save(connection);
          } catch (error) {
            if (credentialChanged) {
              if (saved !== null)
                await credentials.save(request.workspaceId, request.computerId, saved);
              else await credentials.delete(request.workspaceId, request.computerId);
            }
            if (configStore) {
              if (previousConfig) await configStore.save(previousConfig);
              // Preserve the previous active config, if any. Never remove local state on failure.
              else await configStore.clear();
            }
            throw error;
          }
        }
        socket.write(
          frameLocalRpc(
            encodeLocalRpcResponse({
              method: LOCAL_RPC_METHODS.CONFIGURE,
              payload: encodeDaemonRuntimeConfigureResponse({
                protocolMajor: 1,
                requestId: request.requestId,
                accepted: valid,
              }),
            }),
          ),
        );
      } else {
        logger.warn("Local RPC request used an unknown method", {
          event: "daemon.local_rpc.unknown_method",
          method: envelope.method,
          outcome: "rejected",
        });
        socket.end();
        return;
      }
    } catch (error) {
      // Closing the connection is the right response - the caller is a local process that will
      // retry - but doing it silently was not. Every guard in the handlers above (a server-origin
      // mismatch, a runtime that refuses to configure, a malformed frame) reached the caller as an
      // indistinguishable closed socket, and `coforge-computer setup` could only report that the
      // Daemon "could not be started" without ever being able to say why. This line is the only
      // place that knows.
      logger.error("Local RPC request failed", {
        event: "daemon.local_rpc.failed",
        method: currentMethod,
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
        outcome: "error",
      });
      socket.end();
      return;
    }
  }
}
