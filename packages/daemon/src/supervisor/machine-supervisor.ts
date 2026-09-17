import { getLogger } from "@logtape/logtape";
import type { DaemonConfig } from "../daemon-runtime/runtime";
import { holdRunnersUntilQuiescent, type RunnerHoldSnapshot } from "./runner-hold";

export type RestartProgress = {
  requestId: string;
  phase: "stopping" | "starting";
  previousInstanceId: string | null;
};
export type RestartResult =
  | { requestId: string; status: "completed"; instanceId: string }
  | { requestId: string; status: "cancelled" };

/**
 * One Computer upgrade operation as this machine knows it. `pending` means an external one-shot
 * job was launched and has not left a receipt yet; `succeeded`/`failed` carry that receipt;
 * `acknowledged` means the server accepted the reported result and the record is audit only.
 */
export type UpgradeOperationState = "pending" | "succeeded" | "failed" | "acknowledged";
export type UpgradeOperationTerminal = { version?: string; error?: string; at: number };
export type UpgradeOperation = {
  requestId: string;
  expectedVersion: string;
  state: UpgradeOperationState;
  /** When this machine opened the operation, so a stranded one can be aged out. */
  requestedAt: number;
  terminal?: UpgradeOperationTerminal;
};
/** How many operation records one binding keeps, newest last, including the audit tail. */
export const UPGRADE_OPERATION_HISTORY = 128;
/**
 * How long a pending operation may go without a receipt before it is settled as failed. A job
 * that never ran, or whose receipt was lost, must not hold the single pending slot forever. The
 * margin is deliberate: the server's own request TTL is ten minutes, so anything this old has
 * already been given up on upstream.
 */
export const UPGRADE_OPERATION_PENDING_TTL_MS = 30 * 60_000;

export type ManagedBinding = DaemonConfig & {
  enabled: boolean;
  restart?: RestartProgress;
  restartResults?: RestartResult[];
  /** Legacy cloud ready hints, never proof of a completed local operation. */
  restartRequestIds?: string[];
  upgradeRequestIds?: string[];
  /** Pre-receipt dedupe list; FileBindingStore reopens these as pending operations. */
  upgradeRequests?: { requestId: string; expectedVersion: string }[];
  upgradeOperations?: UpgradeOperation[];
};

/**
 * What a blocking pending operation resolves to when it turns out to already be settle-able
 * (its job's receipt exists, or it has aged past the pending TTL). Structurally the same shape
 * `completeUpgrade` accepts, so `recordUpgrade` can apply it the same way.
 */
export type PendingUpgradeSettlement = {
  status: "succeeded" | "failed";
} & UpgradeOperationTerminal;

/**
 * Given the pending operation blocking a new `recordUpgrade` call, reports its settlement if one
 * is already available (a receipt, or the pending TTL has passed), or `undefined` if it is
 * genuinely still in flight. Reads only - the caller applies the settlement, since this runs
 * inside `recordUpgrade`'s own serialized mutation and must not re-enter it.
 */
export type PendingUpgradeSettler = (
  workspaceId: string,
  requestId: string,
  requestedAt: number,
) => Promise<PendingUpgradeSettlement | undefined>;

/** A terminal operation the server has not accepted yet. */
export function reportableUpgradeOperations(binding: ManagedBinding): UpgradeOperation[] {
  return (binding.upgradeOperations ?? []).filter(
    (operation) => operation.state === "succeeded" || operation.state === "failed",
  );
}
export class WorkspaceRecoveryError extends AggregateError {}
export interface BindingStore {
  load(): Promise<ManagedBinding[]>;
  save(bindings: ManagedBinding[]): Promise<void>;
}
export interface WorkspaceProcesses {
  start(binding: ManagedBinding): Promise<string>;
  stop(binding: ManagedBinding): Promise<void>;
  instance(binding: ManagedBinding): Promise<string | null>;
  /**
   * Asks one Workspace daemon to stop admitting new turns and reports which of its Agents are
   * still busy. Optional: a `WorkspaceProcesses` that cannot reach its children simply restarts
   * with today's behaviour (ADR 0021).
   */
  hold?(binding: ManagedBinding, reason: string): Promise<RunnerHoldSnapshot>;
  /** Lifts a hold on a daemon that, against expectations, survived: only called when the OS stop
   * after a hold failed, so the still-running daemon does not sit held with nobody to lift it. */
  release?(binding: ManagedBinding, reason: string): Promise<unknown>;
}

/** Test seam for the bounded restart hold; production takes every default. */
export type RestartHoldTuning = {
  holdMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const logger = getLogger(["coforge", "daemon", "supervisor"]);

/** Serial machine mutations; a stopped binding remains registered and recoverable. */
export class MachineSupervisor {
  #bindings: ManagedBinding[] = [];
  #instances = new Map<string, string>();
  #mutation = Promise.resolve();
  #paused = false;
  #reloadRequired = false;
  constructor(
    private readonly store: BindingStore,
    private readonly processes: WorkspaceProcesses,
    private readonly now: () => number = Date.now,
    private readonly restartHold: RestartHoldTuning = {},
    /**
     * Consulted only when a new upgrade request is blocked by a pending one, so `recordUpgrade`
     * can settle a stale blocker instead of refusing outright (a genuinely in-flight operation is
     * still refused). Omit it to keep the previous behaviour of always refusing.
     */
    private readonly settlePendingUpgrade?: PendingUpgradeSettler,
  ) {}

  recover() {
    return this.#serialize(async () => {
      this.#bindings = await this.store.load();
      this.#reloadRequired = false;
      const failures: Error[] = [];
      for (const workspaceId of this.#bindings.map((binding) => binding.workspaceId)) {
        await this.#refresh();
        const binding = this.#bindings.find((entry) => entry.workspaceId === workspaceId)!;
        try {
          if (!binding.enabled) await this.#stop(binding);
          else if (binding.restart) await this.#advanceRestart(binding);
          else await this.#start(binding);
        } catch (cause) {
          failures.push(new Error(`Workspace ${workspaceId} recovery failed`, { cause }));
        }
      }
      if (failures.length)
        throw new WorkspaceRecoveryError(failures, "Workspace recovery incomplete");
    });
  }

  configure(config: DaemonConfig) {
    return this.#serialize(async () => {
      this.#assertMutable();
      await this.#refresh();
      const previous = this.#bindings.find((binding) => binding.workspaceId === config.workspaceId);
      if (previous?.restart)
        throw new Error("Workspace restart is in progress; stop it before configuring");
      if (previous) await this.#stop(previous);
      const binding = { ...config, enabled: true, restartResults: previous?.restartResults };
      await this.#saveBinding(binding);
      await this.#start(binding);
    });
  }

  command(operation: "start" | "stop" | "restart", workspaceId?: string, requestId?: string) {
    return this.#serialize(async () => {
      this.#assertMutable();
      await this.#refresh();
      const targets = this.#bindings.filter(
        (binding) => !workspaceId || binding.workspaceId === workspaceId,
      );
      if (workspaceId && !targets.length) throw new Error("Workspace is not registered locally");
      for (let binding of targets) {
        if (operation === "restart" && !workspaceId && !binding.enabled) continue;
        if (operation === "stop") {
          binding = await this.#saveBinding({
            ...binding,
            enabled: false,
            restart: undefined,
            restartResults: binding.restart
              ? [
                  ...(binding.restartResults ?? []),
                  { requestId: binding.restart.requestId, status: "cancelled" as const },
                ].slice(-128)
              : binding.restartResults,
          });
          await this.#stop(binding);
          continue;
        }
        if (operation === "restart") {
          const id = requestId ?? crypto.randomUUID();
          const result = binding.restartResults?.find((entry) => entry.requestId === id);
          if (result?.status === "cancelled")
            throw new Error("Workspace restart was cancelled by stop");
          if (result) continue;
          if (binding.restart && binding.restart.requestId !== id)
            throw new Error("Workspace restart is already in progress");
          if (!binding.restart)
            binding = await this.#saveBinding({
              ...binding,
              enabled: true,
              restart: {
                requestId: id,
                phase: "stopping",
                previousInstanceId: await this.processes.instance(binding),
              },
            });
          await this.#advanceRestart(binding);
        } else if (binding.restart) await this.#advanceRestart(binding);
        else {
          binding = await this.#saveBinding({ ...binding, enabled: true });
          await this.#start(binding);
        }
      }
    });
  }

  /**
   * Opens one upgrade operation. Returns whether this call is the one that must launch the
   * external job; a replay of the same request ID returns false. Operations are mutually
   * exclusive: a second request while another is still pending is rejected outright rather than
   * left to collide over the installation lock.
   */
  recordUpgrade(workspaceId: string, requestId: string, expectedVersion: string) {
    return this.#serialize(async () => {
      this.#assertMutable();
      await this.#refresh();
      const binding = this.#bindings.find((entry) => entry.workspaceId === workspaceId);
      if (!binding) throw new Error("Workspace is not registered locally");
      if (!expectedVersion) throw new Error("upgrade expected version is required");
      let operations = binding.upgradeOperations ?? [];
      const existing = operations.find((entry) => entry.requestId === requestId);
      if (existing) {
        if (existing.expectedVersion !== expectedVersion)
          throw new Error("upgrade request already has a different expected version");
        return false;
      }
      const pending = operations.find((entry) => entry.state === "pending");
      if (pending) {
        // A pending slot that is already settle-able (its job left a receipt, or it aged past
        // the TTL) must not refuse a new request forever: only a genuinely in-flight operation
        // still blocks. `settlePendingUpgrade` only reads; this call applies its answer itself,
        // inside the same mutation, rather than re-entering `completeUpgrade`.
        const settlement = await this.settlePendingUpgrade?.(
          workspaceId,
          pending.requestId,
          pending.requestedAt,
        ).catch((error) => {
          logger.warn("Settling a pending Computer upgrade operation failed; still refusing", {
            event: "upgrade:pending_settle_check_failed",
            request_id: pending.requestId,
            workspace_id: workspaceId,
            error_message: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        });
        if (!settlement)
          throw new Error(
            `Computer upgrade operation ${pending.requestId} is still pending; wait for it to finish before starting another`,
          );
        const { status, ...terminal } = settlement;
        operations = operations.map((entry) =>
          entry.requestId === pending.requestId ? { ...entry, state: status, terminal } : entry,
        );
        logger.info("Computer upgrade operation reached its terminal state", {
          event: "upgrade:operation_settled",
          request_id: pending.requestId,
          workspace_id: workspaceId,
          status,
        });
      }
      await this.#saveBinding({
        ...binding,
        upgradeOperations: [
          ...operations,
          { requestId, expectedVersion, state: "pending" as const, requestedAt: this.now() },
        ].slice(-UPGRADE_OPERATION_HISTORY),
      });
      return true;
    });
  }

  /** Records the durable receipt an operation's external job left behind. */
  completeUpgrade(
    workspaceId: string,
    requestId: string,
    terminal: { status: "succeeded" | "failed" } & UpgradeOperationTerminal,
  ) {
    return this.#serialize(async () => {
      await this.#refresh();
      const binding = this.#bindings.find((entry) => entry.workspaceId === workspaceId);
      const operation = binding?.upgradeOperations?.find((entry) => entry.requestId === requestId);
      if (!binding || !operation || operation.state !== "pending") return false;
      const { status, ...receipt } = terminal;
      await this.#saveBinding({
        ...binding,
        upgradeOperations: binding.upgradeOperations!.map((entry) =>
          entry.requestId === requestId ? { ...entry, state: status, terminal: receipt } : entry,
        ),
      });
      return true;
    });
  }

  /** The server accepted the reported result; the record becomes audit-only history. */
  acknowledgeUpgrade(workspaceId: string, requestId: string) {
    return this.#serialize(async () => {
      await this.#refresh();
      const binding = this.#bindings.find((entry) => entry.workspaceId === workspaceId);
      const operation = binding?.upgradeOperations?.find((entry) => entry.requestId === requestId);
      if (!binding || !operation) return false;
      if (operation.state === "acknowledged") return true;
      if (operation.state === "pending")
        throw new Error("a pending Computer upgrade operation cannot be acknowledged");
      await this.#saveBinding({
        ...binding,
        upgradeOperations: binding.upgradeOperations!.map((entry) =>
          entry.requestId === requestId ? { ...entry, state: "acknowledged" as const } : entry,
        ),
      });
      return true;
    });
  }

  snapshot() {
    return this.#serialize(async () => {
      await this.#refresh();
      return Promise.all(
        this.#bindings.map(async (binding) => ({
          ...binding,
          instanceId: await this.processes.instance(binding),
        })),
      );
    });
  }

  pause() {
    return this.#serialize(async () => {
      this.#paused = true;
    });
  }
  resume() {
    return this.#serialize(async () => {
      this.#paused = false;
    });
  }
  shutdown() {
    return this.#serialize(async () => {
      for (const binding of this.#bindings) await this.#stop(binding);
    });
  }

  async #advanceRestart(binding: ManagedBinding): Promise<void> {
    const restart = binding.restart!;
    if (restart.phase === "stopping") {
      const current = await this.processes.instance(binding);
      // The same stable OS unit may already have replaced its failed invocation.
      // start below still validates the replacement through its scoped handshake.
      if (current === null || current === restart.previousInstanceId) {
        // Only a live instance is worth holding; a dead one has no Agents left to drain.
        if (current !== null) await this.#holdRunners(binding);
        try {
          await this.#stop(binding);
        } catch (error) {
          // The daemon we meant to kill is still up and still held: lift the hold before
          // surfacing the failure, or its Agents would queue turns until someone retries.
          if (current !== null) await this.processes.release?.(binding, "restart").catch(() => {});
          throw error;
        }
      }
      binding = await this.#saveBinding({ ...binding, restart: { ...restart, phase: "starting" } });
    }
    const instanceId = await this.#start(binding);
    if (instanceId === restart.previousInstanceId)
      throw new Error("Workspace restart did not replace the old instance");
    await this.#saveBinding({
      ...binding,
      restart: undefined,
      restartResults: [
        ...(binding.restartResults ?? []),
        {
          requestId: restart.requestId,
          status: "completed" as const,
          instanceId,
        },
      ].slice(-128),
    });
  }
  /**
   * Bounded runner hold before a restart stops a live Workspace daemon (ADR 0021). Without it
   * `#stop` hands the Agents the ~2s SIGTERM/SIGKILL ladder in `DaemonRuntime.stop()`, which is
   * not enough for a tool call. Only `restart` holds: `stop` is an operator saying "now".
   *
   * Nothing releases the hold afterwards, and nothing needs to. It is in-memory in the Workspace
   * daemon and `#stop` kills that process; the replacement is born without a hold (ADR 0020,
   * "the hold is never persisted"). The one exception is a stop that fails: the daemon survives
   * held, so `#advanceRestart` releases it before rethrowing; a later retry re-asks, which is
   * idempotent.
   *
   * The wait runs inside the serialized mutation, so other lifecycle commands queue behind it for
   * up to `RUNNER_HOLD_MS`. That is accepted: an upgrade's `pauseLaunches` already blocks the same
   * queue for as long, and a restart that raced ahead of the drain would defeat the point.
   *
   * Every failure resolves towards proceeding: `holdRunnersUntilQuiescent` reports quiescent when
   * the hold cannot be asked at all, and a Workspace that answers `accepted: false` or times out
   * is counted as idle. A restart is never failed because of the hold.
   */
  async #holdRunners(binding: ManagedBinding): Promise<void> {
    if (!this.processes.hold) return;
    const outcome = await holdRunnersUntilQuiescent({
      hold: () => this.processes.hold!(binding, "restart"),
      ...this.restartHold,
    });
    logger.info("Runner hold completed before a Workspace restart", {
      event: outcome.quiescent ? "restart:runner_hold_quiescent" : "restart:runner_hold_expired",
      workspace_id: binding.workspaceId,
      quiescent: outcome.quiescent,
      elapsed_ms: outcome.elapsedMs,
      busy_agent_count: outcome.busyAgents.length,
      unreachable_workspace_ids: outcome.unreachableWorkspaceIds,
    });
  }
  async #saveBinding(binding: ManagedBinding): Promise<ManagedBinding> {
    const next = this.#bindings.filter((entry) => entry.workspaceId !== binding.workspaceId);
    const index = this.#bindings.findIndex((entry) => entry.workspaceId === binding.workspaceId);
    next.splice(index < 0 ? next.length : index, 0, binding);
    try {
      await this.store.save(next);
    } catch (error) {
      // A failure after rename may have committed. Re-read before any later mutation.
      this.#reloadRequired = true;
      throw error;
    }
    this.#bindings = next;
    return binding;
  }
  async #refresh() {
    if (!this.#reloadRequired) return;
    this.#bindings = await this.store.load();
    this.#reloadRequired = false;
  }
  async #start(binding: ManagedBinding): Promise<string> {
    const expected = this.#instances.get(binding.workspaceId);
    if (expected && (await this.processes.instance(binding)) === expected) return expected;
    this.#instances.delete(binding.workspaceId);
    const instanceId = await this.processes.start(binding);
    this.#instances.set(binding.workspaceId, instanceId);
    return instanceId;
  }
  async #stop(binding: ManagedBinding) {
    await this.processes.stop(binding);
    this.#instances.delete(binding.workspaceId);
  }
  #assertMutable() {
    if (this.#paused) throw new Error("machine lifecycle is paused for upgrade");
  }
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutation.then(operation);
    this.#mutation = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
