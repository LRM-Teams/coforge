import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  decodeDaemonHandshakeRequest,
  encodeDaemonHandshakeResponse,
  frameLocalRpc,
  readLocalRpcFrames,
} from "@coforge/protocol";

export type DaemonLocalRpcServer = {
  close(): Promise<void>;
};

export async function startDaemonLocalRpcServer(input: {
  socketPath: string;
  validateCredential?: (credential: string) => boolean;
}): Promise<DaemonLocalRpcServer> {
  await mkdir(dirname(input.socketPath), { recursive: true, mode: 0o700 });
  await rm(input.socketPath, { force: true });
  const daemonId = crypto.randomUUID();
  const server = Bun.listen<LocalSocketData>({
    unix: input.socketPath,
    socket: {
      open(socket) {
        socket.data = { buffer: new Uint8Array() };
      },
      data(socket, chunk) {
        handleConnection(socket, chunk, daemonId, input.validateCredential);
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

type LocalSocketData = { buffer: Uint8Array };

function handleConnection(
  socket: Bun.Socket<LocalSocketData>,
  chunk: Uint8Array,
  daemonId: string,
  validateCredential: ((credential: string) => boolean) | undefined,
): void {
  const next = new Uint8Array(socket.data.buffer.byteLength + chunk.byteLength);
  next.set(socket.data.buffer);
  next.set(chunk, socket.data.buffer.byteLength);
  socket.data.buffer = next;
  const parsed = readLocalRpcFrames(socket.data.buffer);
  socket.data.buffer = parsed.remainder;
  for (const frame of parsed.frames) {
    try {
      const request = decodeDaemonHandshakeRequest(frame);
      const accepted =
        request.protocolMajor === 1 &&
        request.daemonWorkspaceCredential.length > 0 &&
        (validateCredential?.(request.daemonWorkspaceCredential) ?? true);
      socket.write(
        frameLocalRpc(
          encodeDaemonHandshakeResponse({
            protocolMajor: 1,
            requestId: request.requestId,
            daemonId,
            accepted,
          }),
        ),
      );
    } catch {
      socket.end();
      return;
    }
  }
}
