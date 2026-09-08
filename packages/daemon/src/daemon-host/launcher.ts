import { access } from "node:fs/promises";
import { join, win32 } from "node:path";
import {
  decodeDaemonHandshakeResponse,
  decodeDaemonCommandResponse,
  encodeDaemonCommandRequest,
  decodeDaemonRuntimeConfigureResponse,
  encodeDaemonHandshakeRequest,
  encodeDaemonRuntimeConfigureRequest,
  frameLocalRpc,
  readLocalRpcFrame,
  encodeLocalRpcRequest,
  decodeLocalRpcResponse,
  LOCAL_RPC_METHODS,
} from "@coforge/protocol";
import type { DaemonHandshakeResponse } from "@coforge/protocol";
import { DaemonConfigStore } from "../persistence/daemon-config";

export interface DaemonLauncher {
  preflight?(): Promise<void>;
  ensureStarted(input: DaemonWorkspaceConfig): Promise<void>;
  stopAll?(): Promise<void>;
}
export interface DaemonCommandRunner {
  ensureRunning(): Promise<void>;
  command(operation: "start" | "stop" | "restart"): Promise<void>;
}
export type DaemonWorkspaceConfig = {
  workspaceId: string;
  computerId: string;
  workspaceRoot: string;
  daemonApiKey: string;
};

export type LocalDaemonConnection = {
  request(payload: Uint8Array): Promise<Uint8Array>;
  close(): void;
};

export type LocalDaemonLauncherOptions = {
  executablePath: string;
  socketPath: string;
  stateDirectory: string;
  serverUrl: string;
  connect?: (socketPath: string) => Promise<LocalDaemonConnection>;
  spawn?: (executablePath: string, socketPath: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMilliseconds?: number;
};

export class LocalDaemonLauncher implements DaemonLauncher, DaemonCommandRunner {
  #connect: (socketPath: string) => Promise<LocalDaemonConnection>;
  #spawn: (executablePath: string, socketPath: string) => void;
  #sleep: (milliseconds: number) => Promise<void>;
  #timeoutMilliseconds: number;

  constructor(private readonly options: LocalDaemonLauncherOptions) {
    this.#connect = options.connect ?? connectToLocalDaemon;
    this.#spawn =
      options.spawn ??
      ((executablePath, socketPath) => {
        const process = Bun.spawn(
          [executablePath, "--socket", socketPath, "--state-directory", options.stateDirectory],
          {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          },
        );
        process.unref();
      });
    this.#sleep = options.sleep ?? Bun.sleep;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 10_000;
  }

  async stopAll(): Promise<void> {
    await this.command("stop");
  }

  async preflight(): Promise<void> {
    await new DaemonConfigStore(this.options.stateDirectory, {
      serverHttpUrl: this.options.serverUrl,
    }).load();
    let connection: LocalDaemonConnection;
    try {
      connection = await this.#connect(this.options.socketPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") return;
      throw error;
    }
    try {
      await this.#verifyHandshake(connection);
    } finally {
      connection.close();
    }
  }

  async ensureStarted(input: DaemonWorkspaceConfig): Promise<void> {
    try {
      if (await this.#handshake(input)) return;
    } catch (error) {
      if (isEnvironmentMismatch(error)) throw error;
      throw new Error("coforge-daemon did not accept the local handshake");
    }
    this.#spawn(this.options.executablePath, this.options.socketPath);
    const deadline = Date.now() + this.#timeoutMilliseconds;
    while (Date.now() < deadline) {
      if (await this.#handshake(input)) return;
      await this.#sleep(50);
    }
    throw new Error("coforge-daemon did not accept the local handshake");
  }

  async ensureRunning(): Promise<void> {
    if (await this.#handshake()) return;
    this.#spawn(this.options.executablePath, this.options.socketPath);
    const deadline = Date.now() + this.#timeoutMilliseconds;
    while (Date.now() < deadline) {
      if (await this.#handshake()) return;
      await this.#sleep(50);
    }
    throw new Error("coforge-daemon did not accept the local handshake");
  }

  async command(operation: "start" | "stop" | "restart"): Promise<void> {
    if (operation !== "stop") await this.ensureRunning();
    let connection: LocalDaemonConnection | undefined;
    try {
      connection = await this.#connect(this.options.socketPath);
      await this.#verifyHandshake(connection);
      const requestId = crypto.randomUUID();
      const response = decodeLocalRpcResponse(
        await connection.request(
          frameLocalRpc(
            encodeLocalRpcRequest({
              method: LOCAL_RPC_METHODS[operation.toUpperCase() as "START" | "STOP" | "RESTART"],
              payload: encodeDaemonCommandRequest({
                protocolMajor: 1,
                requestId,
                expectedServerUrl: this.options.serverUrl,
              }),
            }),
          ),
        ),
      );
      const commandResponse = decodeDaemonCommandResponse(response.payload);
      if (
        response.method !==
          LOCAL_RPC_METHODS[operation.toUpperCase() as "START" | "STOP" | "RESTART"] ||
        commandResponse.protocolMajor !== 1 ||
        commandResponse.requestId !== requestId ||
        !commandResponse.accepted
      ) {
        throw new Error(`coforge-daemon did not accept ${operation}`);
      }
    } finally {
      connection?.close();
    }
  }

  async #handshake(config?: DaemonWorkspaceConfig): Promise<boolean> {
    let connection: LocalDaemonConnection;
    try {
      connection = await this.#connect(this.options.socketPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") return false;
      throw error;
    }
    try {
      await this.#verifyHandshake(connection);
      if (!config) return true;
      const configureId = crypto.randomUUID();
      const responseEnvelope = decodeLocalRpcResponse(
        await connection.request(
          frameLocalRpc(
            encodeLocalRpcRequest({
              method: LOCAL_RPC_METHODS.CONFIGURE,
              payload: encodeDaemonRuntimeConfigureRequest({
                protocolMajor: 1,
                requestId: configureId,
                workspaceId: config.workspaceId,
                computerId: config.computerId,
                workspaceRoot: config.workspaceRoot,
                daemonApiKey: config.daemonApiKey,
                expectedServerUrl: this.options.serverUrl,
              }),
            }),
          ),
        ),
      );
      if (responseEnvelope.method !== LOCAL_RPC_METHODS.CONFIGURE)
        throw new Error("coforge-daemon returned an invalid configure response");
      const configured = decodeDaemonRuntimeConfigureResponse(responseEnvelope.payload);
      const accepted =
        configured.protocolMajor === 1 &&
        configured.requestId === configureId &&
        configured.accepted;
      if (!accepted) throw new Error("coforge-daemon did not accept configuration");
      return true;
    } finally {
      connection.close();
    }
  }

  async #verifyHandshake(connection: LocalDaemonConnection): Promise<void> {
    const requestId = crypto.randomUUID();
    const envelope = decodeLocalRpcResponse(
      await connection.request(
        frameLocalRpc(
          encodeLocalRpcRequest({
            method: LOCAL_RPC_METHODS.HANDSHAKE,
            payload: encodeDaemonHandshakeRequest({ protocolMajor: 1, requestId }),
          }),
        ),
      ),
    );
    if (envelope.method !== LOCAL_RPC_METHODS.HANDSHAKE)
      throw new Error("coforge-daemon returned an invalid handshake");
    const response = decodeDaemonHandshakeResponse(envelope.payload);
    if (
      !validHandshakeResponse(response, requestId) ||
      !response.serverUrl ||
      new URL(response.serverUrl).origin !== new URL(this.options.serverUrl).origin
    ) {
      throw new Error("coforge-daemon server does not match this Computer build");
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

function isEnvironmentMismatch(error: unknown): boolean {
  return error instanceof Error && error.message.includes("server does not match");
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
      end(_socket) {
        rejectResponse?.(new Error("local daemon socket closed"));
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
