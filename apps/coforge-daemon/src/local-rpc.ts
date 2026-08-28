import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  decodeDaemonHandshakeRequest,
  decodeWorkspaceWorkerConfigureRequest,
  encodeWorkspaceWorkerConfigureResponse,
  encodeDaemonHandshakeResponse,
  frameLocalRpc,
  readLocalRpcFrames,
  decodeLocalRpcRequest,
  encodeLocalRpcResponse,
  LOCAL_RPC_METHODS,
} from "@coforge/protocol";
import type { DaemonCoordinator } from "./daemon-coordinator";
import type { WorkspaceWorkerCredentialStore } from "./workspace-worker/credential-store";
import type { WorkspaceConnectionRegistry } from "./persistence/workspace-connection-registry";

export type DaemonLocalRpcServer = {
  close(): Promise<void>;
};

export async function startDaemonLocalRpcServer(input: {
  socketPath: string;
  validateCredential: (credential: string) => boolean | Promise<boolean>;
  runtime: Pick<DaemonCoordinator, "configureWorkspaceWorker">;
  credentials: WorkspaceWorkerCredentialStore;
  registry?: WorkspaceConnectionRegistry;
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
              input.registry,
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
  runtime: Pick<DaemonCoordinator, "configureWorkspaceWorker">,
  credentials: WorkspaceWorkerCredentialStore,
  registry: WorkspaceConnectionRegistry | undefined,
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
      } else if (envelope.method === LOCAL_RPC_METHODS.CONFIGURE) {
        const request = decodeWorkspaceWorkerConfigureRequest(envelope.payload);
        const valid =
          request.protocolMajor === 1 &&
          [
            request.workspaceId,
            request.connectionId,
            request.workspaceRoot,
            request.workspaceWorkerToken,
          ].every(Boolean) &&
          (await validateCredential(request.workspaceWorkerToken));
        if (valid) {
          const saved = await credentials.load(request.connectionId);
          const previousConnection = registry
            ? (await registry.list()).find((entry) => entry.connectionId === request.connectionId)
            : undefined;
          const credentialChanged = saved !== request.workspaceWorkerToken;
          if (credentialChanged) {
            await credentials.save(request.connectionId, request.workspaceWorkerToken);
          }
          const connection = {
            workspaceId: request.workspaceId,
            connectionId: request.connectionId,
            workspaceRoot: request.workspaceRoot,
          };
          let registryWriteStarted = false;
          try {
            await runtime.configureWorkspaceWorker(connection);
            registryWriteStarted = registry !== undefined;
            await registry?.upsert(connection);
          } catch (error) {
            if (credentialChanged) {
              if (saved === null) await credentials.delete(request.connectionId);
              else await credentials.save(request.connectionId, saved);
            }
            if (registryWriteStarted) {
              if (previousConnection) await registry!.upsert(previousConnection);
              else await registry!.delete(request.connectionId);
            }
            throw error;
          }
        }
        socket.write(
          frameLocalRpc(
            encodeLocalRpcResponse({
              method: LOCAL_RPC_METHODS.CONFIGURE,
              payload: encodeWorkspaceWorkerConfigureResponse({
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
