import { access } from "node:fs/promises";
import { join, win32 } from "node:path";
import {
  decodeDaemonHandshakeResponse,
  encodeDaemonHandshakeRequest,
  frameLocalRpc,
  readLocalRpcFrame,
} from "@coforge/protocol";
import type { DaemonHandshakeResponse } from "@coforge/protocol";

export interface DaemonLauncher {
  ensureStarted(credential: string): Promise<void>;
}

export type LocalDaemonConnection = {
  request(payload: Uint8Array): Promise<Uint8Array>;
  close(): void;
};

export type LocalDaemonLauncherOptions = {
  executablePath: string;
  socketPath: string;
  connect?: (socketPath: string) => Promise<LocalDaemonConnection>;
  spawn?: (executablePath: string, socketPath: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMilliseconds?: number;
};

export class LocalDaemonLauncher implements DaemonLauncher {
  #connect: (socketPath: string) => Promise<LocalDaemonConnection>;
  #spawn: (executablePath: string, socketPath: string) => void;
  #sleep: (milliseconds: number) => Promise<void>;
  #timeoutMilliseconds: number;

  constructor(private readonly options: LocalDaemonLauncherOptions) {
    this.#connect = options.connect ?? connectToLocalDaemon;
    this.#spawn =
      options.spawn ??
      ((executablePath, socketPath) => {
        Bun.spawn([executablePath, "--socket", socketPath], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
      });
    this.#sleep = options.sleep ?? Bun.sleep;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 10_000;
  }

  async ensureStarted(credential: string): Promise<void> {
    if (await this.#handshake(credential)) return;
    this.#spawn(this.options.executablePath, this.options.socketPath);
    const deadline = Date.now() + this.#timeoutMilliseconds;
    while (Date.now() < deadline) {
      if (await this.#handshake(credential)) return;
      await this.#sleep(50);
    }
    throw new Error("coforge-daemon did not accept the local handshake");
  }

  async #handshake(credential: string): Promise<boolean> {
    let connection: LocalDaemonConnection;
    try {
      connection = await this.#connect(this.options.socketPath);
    } catch {
      return false;
    }
    try {
      const requestId = crypto.randomUUID();
      const response = decodeDaemonHandshakeResponse(
        await connection.request(
          frameLocalRpc(
            encodeDaemonHandshakeRequest({
              protocolMajor: 1,
              requestId,
              daemonWorkspaceCredential: credential,
            }),
          ),
        ),
      );
      return validHandshakeResponse(response, requestId);
    } catch {
      return false;
    } finally {
      connection.close();
    }
  }
}

export function resolveDaemonExecutablePath(input: {
  installRoot: string;
  platform: NodeJS.Platform;
}): string {
  const name = input.platform === "win32" ? "coforge-daemon.exe" : "coforge-daemon";
  if (input.platform === "win32") return win32.join(input.installRoot, "active", name);
  return join(input.installRoot, "active", name);
}

export async function assertDaemonExecutable(path: string): Promise<void> {
  await access(path);
}

function validHandshakeResponse(response: DaemonHandshakeResponse, requestId: string): boolean {
  return response.protocolMajor === 1 && response.requestId === requestId && response.accepted;
}

function connectToLocalDaemon(socketPath: string): Promise<LocalDaemonConnection> {
  return connectWithBun(socketPath);
}

async function connectWithBun(socketPath: string): Promise<LocalDaemonConnection> {
  let buffer = new Uint8Array();
  let resolveResponse: ((payload: Uint8Array) => void) | undefined;
  let rejectResponse: ((error: Error) => void) | undefined;
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_socket, chunk) {
        const next = new Uint8Array(buffer.byteLength + chunk.byteLength);
        next.set(buffer);
        next.set(chunk, buffer.byteLength);
        buffer = next;
        const frame = readLocalRpcFrame(buffer);
        if (!frame || !resolveResponse) return;
        const resolve = resolveResponse;
        resolveResponse = undefined;
        rejectResponse = undefined;
        resolve(frame);
        buffer = new Uint8Array();
      },
      error(_socket, error) {
        rejectResponse?.(error instanceof Error ? error : new Error("local daemon socket failed"));
      },
      connectError(_socket, error) {
        rejectResponse?.(error instanceof Error ? error : new Error("local daemon socket failed"));
      },
    },
  });
  return {
    request(payload) {
      return new Promise((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
        socket.write(payload);
      });
    },
    close() {
      socket.end();
    },
  };
}
