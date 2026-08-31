import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
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
  type AgentMessageResponse,
} from "@coforge/protocol";
import type { DaemonConfig } from "./daemon-runtime/runtime";
import type { DaemonCredentialStore } from "./credentials/credential-store";
import type { DaemonConfigStore } from "./persistence/daemon-config";

export type DaemonLocalRpcServer = {
  close(): Promise<void>;
};

type DaemonRuntimePort = Partial<{
  configure(connection: DaemonConfig): Promise<void>;
  start(): Promise<void>;
  stopAll(): Promise<void>;
  restart(): Promise<void>;
  agentMessage(
    context: string,
    request: import("@coforge/protocol").LocalAgentMessageRequest,
  ): Promise<unknown>;
}>;

export async function startDaemonLocalRpcServer(input: {
  socketPath: string;
  validateCredential: (credential: string) => boolean | Promise<boolean>;
  runtime: DaemonRuntimePort;
  credentials: DaemonCredentialStore;
  configStore?: Pick<DaemonConfigStore, "load" | "save" | "clear">;
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
              input.validateCredential,
              input.runtime,
              input.credentials,
              input.configStore,
            ),
          )
          .catch(() => {
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
  validateCredential: (credential: string) => boolean | Promise<boolean>,
  runtime: DaemonRuntimePort,
  credentials: DaemonCredentialStore,
  configStore: Pick<DaemonConfigStore, "load" | "save" | "clear"> | undefined,
): Promise<void> {
  const next = new Uint8Array(socket.data.buffer.byteLength + chunk.byteLength);
  next.set(socket.data.buffer);
  next.set(chunk, socket.data.buffer.byteLength);
  socket.data.buffer = next;
  const parsed = readLocalRpcFrames(socket.data.buffer);
  socket.data.buffer = parsed.remainder;
  for (const frame of parsed.frames) {
    try {
      const envelope = decodeLocalRpcRequest(frame);
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
      } else if (
        envelope.method === LOCAL_RPC_METHODS.START ||
        envelope.method === LOCAL_RPC_METHODS.STOP ||
        envelope.method === LOCAL_RPC_METHODS.RESTART
      ) {
        const request = decodeDaemonCommandRequest(envelope.payload);
        const valid = request.protocolMajor === 1 && request.requestId.length > 0;
        if (valid) {
          if (envelope.method === LOCAL_RPC_METHODS.START && runtime.start) await runtime.start();
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
              }),
            }),
          ),
        );
      } else if (envelope.method === LOCAL_RPC_METHODS.CONFIGURE) {
        const request = decodeDaemonRuntimeConfigureRequest(envelope.payload);
        const valid =
          request.protocolMajor === 1 &&
          [
            request.workspaceId,
            request.computerId,
            request.workspaceRoot,
            request.daemonToken,
          ].every(Boolean) &&
          (await validateCredential(request.daemonToken));
        if (valid) {
          const saved = await credentials.load(request.workspaceId, request.computerId);
          const previousConfig = await configStore?.load();
          const credentialChanged = saved !== request.daemonToken;
          if (credentialChanged) {
            await credentials.save(request.workspaceId, request.computerId, request.daemonToken);
          }
          const connection = {
            workspaceId: request.workspaceId,
            computerId: request.computerId,
            workspaceRoot: request.workspaceRoot,
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
        socket.end();
        return;
      }
    } catch {
      socket.end();
      return;
    }
  }
}
