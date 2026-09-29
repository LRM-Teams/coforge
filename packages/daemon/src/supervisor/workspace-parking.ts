import { getLogger } from "@logtape/logtape";
import type { DaemonConnectRejectionReason } from "@lrm/coforge-sdk/internal";
import { DaemonConnectionRefusedError } from "#src/connection/daemon-connection-refused-error";
import { type WorkspaceHealthJournal, workspaceParkedMessage } from "./workspace-health-journal";

const logger = getLogger(["coforge", "daemon"]);

/** Where this Workspace process's latest cloud connect stands, as its handshake reports it. */
export type WorkspaceCloudConnectionState =
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "not_connected"; error: string };

/**
 * One Workspace process's answer to the cloud refusing its connection for good: record the park
 * in the Workspace's health journal before anything else, then shut the process down so it exits
 * 0, which ends both OS supervisors' restarts. Also tracks where the latest cloud connect stands,
 * which the Coordinator reports back to an operator's start.
 */
export class WorkspaceParking {
  #connection: WorkspaceCloudConnectionState = { state: "connecting" };
  #parking: Promise<void> | undefined;
  readonly #shutdown = Promise.withResolvers<() => Promise<void>>();

  constructor(
    private readonly journal: WorkspaceHealthJournal,
    private readonly workspaceId: () => string | undefined,
  ) {}

  /** A refusal for good stays "connecting": the process parks and exits instead. */
  get cloudConnection(): WorkspaceCloudConnectionState {
    return this.#connection;
  }

  /** Starts a Workspace runtime. Every start goes through here, so a refusal parks the Workspace
   * whichever caller started it. */
  async start(run: () => Promise<void>): Promise<void> {
    this.#connection = { state: "connecting" };
    try {
      await run();
      this.#connection = { state: "connected" };
    } catch (error) {
      if (error instanceof DaemonConnectionRefusedError) void this.park(error.reason);
      else this.#connection = { state: "not_connected", error: connectFailureReason(error) };
      throw error;
    }
  }

  /** A start with nothing to connect: no Workspace is configured. */
  unconfigured(): void {
    this.#connection = { state: "not_connected", error: "no Workspace is configured" };
  }

  /** Parks the Workspace, once, then shuts the process down as soon as its shutdown exists. */
  park(reason: DaemonConnectRejectionReason): Promise<void> {
    this.#parking ??= this.#park(reason);
    return this.#parking;
  }

  /** Logs a Workspace that booted already parked. */
  logParked(reason: DaemonConnectRejectionReason): void {
    logger.error(workspaceParkedMessage(reason, { workspaceId: this.workspaceId() ?? "" }), {
      event: "daemon:workspace_parked",
      reason,
    });
  }

  /** Hands over the process's shutdown once the entrypoint has assembled it; resolves after a
   * park already in progress has used it. */
  async bindShutdown(shutdown: () => Promise<void>): Promise<void> {
    this.#shutdown.resolve(shutdown);
    if (this.#parking) await this.#parking;
  }

  async #park(reason: DaemonConnectRejectionReason): Promise<void> {
    await this.journal.markParked(reason);
    this.logParked(reason);
    const shutdown = await this.#shutdown.promise;
    await shutdown();
  }
}

/** A short, secret-free reason: the realtime client's own `{ error: { code, message } }`, or an
 * Error's message. */
function connectFailureReason(error: unknown): string {
  const inner = (error as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (inner && typeof inner.message === "string")
    return typeof inner.code === "number" ? `${inner.message} (${inner.code})` : inner.message;
  if (error instanceof Error && error.message) return error.message.slice(0, 200);
  return "unknown error";
}
