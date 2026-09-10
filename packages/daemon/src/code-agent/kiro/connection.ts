import {
  client,
  type AnyMessage,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { JsonlProcess } from "../jsonl-process";
import { COFORGE_DAEMON_VERSION } from "../../version";

export const KIRO_ACP_ARGS = ["acp", "--agent-engine", "v3", "--auth-method", "cli"] as const;

/** ACP owns RPC framing/validation; JsonlProcess retains the existing process-tree lifecycle. */
export class KiroConnection {
  readonly process: JsonlProcess;
  readonly connection;
  readonly #config = new Map<string, SessionConfigOption[]>();
  readonly #configChanged = new Set<() => void>();
  #closed = false;

  constructor(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
    onUpdate: (notification: SessionNotification) => void = () => {},
    onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse = () => ({
      outcome: { outcome: "cancelled" },
    }),
  ) {
    this.process = new JsonlProcess(command, cwd, environment);
    let unsubscribe: (() => void) | undefined;
    const readable = new ReadableStream<AnyMessage>({
      start: (controller) => {
        unsubscribe = this.process.onRecord((record) => controller.enqueue(record as AnyMessage));
      },
      cancel: () => unsubscribe?.(),
    });
    this.connection = client({ name: "coforge-daemon" })
      .onNotification("session/update", ({ params }) => {
        if (params.update.sessionUpdate === "config_option_update") {
          this.#config.set(params.sessionId, params.update.configOptions);
          for (const listener of this.#configChanged) listener();
        }
        onUpdate(params);
      })
      .onRequest("session/request_permission", ({ params }) => onPermission(params))
      .connect({
        readable,
        writable: new WritableStream<AnyMessage>({
          write: (message) => this.process.send(message),
        }),
      });
    this.process.onFailure(() => this.#close());
    this.process.onClose(() => this.#close());
  }

  async waitForConfig(
    sessionId: string,
    initial: SessionConfigOption[],
    category: string,
    timeoutMs = 30_000,
  ) {
    const ready = (options: SessionConfigOption[]) =>
      options.some(
        (option) =>
          (option.category === category || option.id === category) &&
          option.type === "select" &&
          option.options.some((entry) => "value" in entry || entry.options.length > 0),
      );
    if (ready(initial)) return initial;
    let check: () => void = () => {};
    try {
      return await bounded(
        new Promise<SessionConfigOption[]>((resolve, reject) => {
          check = () => {
            if (this.#closed)
              return reject(new Error("Kiro ACP process closed before configuration"));
            const options = this.#config.get(sessionId);
            if (options && ready(options)) resolve(options);
          };
          this.#configChanged.add(check);
          check();
        }),
        timeoutMs,
      );
    } finally {
      this.#configChanged.delete(check);
    }
  }

  #close() {
    this.#closed = true;
    this.connection.close();
    for (const listener of this.#configChanged) listener();
    this.#config.clear();
  }

  async initialize() {
    const response = await bounded(
      this.connection.agent.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "coforge-daemon", version: COFORGE_DAEMON_VERSION },
      }),
    );
    if (
      response.protocolVersion !== 1 ||
      !response.agentCapabilities?.loadSession ||
      !record(response.agentCapabilities._meta?.kiro)?.replayMarking
    ) {
      throw new Error("Kiro v3 ACP capabilities are unavailable; update kiro-cli");
    }
    return response;
  }

  async dispose() {
    this.#close();
    await this.process.dispose();
  }
}

export async function bounded<T>(promise: Promise<T>, timeoutMs = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Kiro ACP operation timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
