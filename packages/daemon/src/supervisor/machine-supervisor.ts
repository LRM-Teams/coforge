import { getLogger } from "@logtape/logtape";
import type { DaemonConnectRejectionReason } from "@lrm/coforge-sdk/internal";
import type { DaemonConfig } from "#src/daemon-runtime/runtime";
import { holdRunnersUntilQuiescent, RUNNER_HOLD_MS, type RunnerHoldSnapshot } from "./runner-hold";
import { UpgradeLaunchesPausedError, UpgradeOperationPendingError } from "./upgrade-error";
import { WorkspaceParkedError } from "./workspace-health-journal";

export type RestartProgress = {
  requestId: string;
  phase: "stopping" | "starting";
  previousInstanceId: string | null;
};
export type RestartResult =
  | { requestId: string; status: "completed"; instanceId: string }
  | { requestId: string; status: "cancelled" };

/**
 * The canonical local Computer upgrade operation. `pending` means an external one-shot job was
 * launched and has not supplied terminal evidence yet; `succeeded`/`failed` are the one settled
 * outcome projected to child config/cloud; `acknowledged` means server acceptance and bounded
 * audit history. The immutable result file is evidence applied to this record, not a peer state.
 */
export type UpgradeOperationState = "pending" | "succeeded" | "failed" | "acknowledged";
export type UpgradeOperationTerminal = {
  version?: string;
  error?: string;
  /** See `UPGRADE_ERROR_CODE`. Set only when the job (or the Coordinator, on a launch failure)
   * can name a stable reason for this terminal state. */
  errorCode?: string;
  at: number;
};
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

export class WorkspaceRecoveryError extends AggregateError {}
export interface BindingStore {
  load(): Promise<ManagedBinding[]>;
  save(bindings: ManagedBinding[]): Promise<void>;
}
/**
 * An operator command's one deadline (epoch ms). It bounds when the command answers, not the work:
 * what is still under way at the deadline finishes in the serialized queue after the answer.
 */
export type CommandOptions = { deadline?: number };
/** Which targeted Workspaces an operator command finished starting, and which were still under
 * way (queued, holding, stopping, or starting) when its deadline came. */
export type CommandAnswer = { started: string[]; pending: string[] };

/** What one command has got through so far, read when its deadline answers before it finishes. */
type CommandProgress = {
  targets?: string[];
  settled: Set<string>;
  started: string[];
  refused?: WorkspaceParkedError;
};

export interface WorkspaceProcesses {
  start(binding: ManagedBinding): Promise<string>;
  stop(binding: ManagedBinding): Promise<void>;
  instance(binding: ManagedBinding): Promise<string | null>;
  /**
   * Asks one Workspace daemon to stop admitting new turns and reports which of its Agents are
   * still busy. Optional: a `WorkspaceProcesses` that cannot reach its children simply restarts
   * with today's behaviour.
   */
  hold?(binding: ManagedBinding, reason: string): Promise<RunnerHoldSnapshot>;
  /** Lifts a hold on a daemon that, against expectations, survived: only called when the OS stop
   * after a hold failed, so the still-running daemon does not sit held with nobody to lift it. */
  release?(binding: ManagedBinding, reason: string): Promise<unknown>;
  /** Clears this Workspace's crash/terminal health latch. Called only for an explicit operator
   * `start`/`restart` through `command()` - never from automatic recovery on Coordinator startup,
   * and never from `stop` - so an OS-level crash-loop restart (which never reaches `command()`)
   * cannot clear its own latch. Optional: a `WorkspaceProcesses` with no health journal to clear
   * simply never latches. */
  clearHealth?(binding: ManagedBinding): Promise<void>;
  /** Why the cloud refused this Workspace for good, if it did. A parked Workspace is never
   * started by recovery, start, or restart; only `configure` (a rebind) lifts the park. */
  parkedReason?(binding: ManagedBinding): Promise<DaemonConnectRejectionReason | undefined>;
  clearParked?(binding: ManagedBinding): Promise<void>;
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

  recover(options: { paused?: boolean } = {}) {
    return this.#serialize(async () => {
      this.#bindings = await this.store.load();
      this.#reloadRequired = false;
      this.#paused = options.paused ?? false;
      if (!this.#paused) await this.#reconcileBindings();
    });
  }

  /**
   * Re-applies enabled/disabled intent for every binding. Used on Coordinator startup/resume and,
   * on Windows (no OS-level Workspace restart), by a periodic poll that replaces systemd/launchd
   * failure restart. No-ops while paused for Computer upgrade.
   */
  reconcile() {
    return this.#serialize(async () => {
      if (this.#paused) return;
      await this.#refresh();
      await this.#reconcileBindings();
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
      await this.processes.clearParked?.(binding);
      await this.#saveBinding(binding);
      await this.#start(binding);
    });
  }

  /**
   * Starts, stops, or restarts the targeted bindings and resolves with the Workspaces it started.
   * With a `deadline` the command answers by then even if it is still queued or under way: the
   * Workspaces it has not finished are `pending`, and their work completes in the serialized
   * queue afterwards, so an adopted instance and a restart's result are still recorded.
   */
  command(
    operation: "start" | "stop" | "restart",
    workspaceId?: string,
    requestId?: string,
    options: CommandOptions = {},
  ): Promise<CommandAnswer> {
    const progress: CommandProgress = { settled: new Set(), started: [] };
    const work = this.#serialize(() =>
      this.#command(operation, workspaceId, requestId, options, progress),
    );
    if (options.deadline === undefined) return work;
    return this.#answerBy(options.deadline, work, () => {
      if (progress.refused) throw progress.refused;
      const targets = progress.targets ?? this.#targets(operation, workspaceId);
      return {
        started: [...progress.started],
        pending: targets.filter((id) => !progress.settled.has(id)),
      };
    });
  }

  /**
   * The bindings as this supervisor last recorded them, each with its live OS instance, without
   * waiting behind a lifecycle mutation still under way. What an operator reads (`status`, a
   * command's answer) comes from here, so it never outlasts its caller.
   */
  async view() {
    return Promise.all(
      this.#bindings.map(async (binding) => ({
        ...binding,
        instanceId: await this.processes.instance(binding),
      })),
    );
  }

  /** The Workspaces a command acts on: an unscoped restart leaves disabled bindings alone. */
  #targets(operation: "start" | "stop" | "restart", workspaceId?: string): string[] {
    return this.#bindings
      .filter((binding) => !workspaceId || binding.workspaceId === workspaceId)
      .filter((binding) => !(operation === "restart" && !workspaceId && !binding.enabled))
      .map((binding) => binding.workspaceId);
  }

  async #command(
    operation: "start" | "stop" | "restart",
    workspaceId: string | undefined,
    requestId: string | undefined,
    options: CommandOptions,
    progress: CommandProgress,
  ): Promise<CommandAnswer> {
    this.#assertMutable();
    await this.#refresh();
    if (workspaceId && !this.#bindings.some((binding) => binding.workspaceId === workspaceId))
      throw new Error("Workspace is not registered locally");
    progress.targets = this.#targets(operation, workspaceId);
    for (const id of progress.targets) {
      let binding = this.#bindings.find((entry) => entry.workspaceId === id)!;
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
        progress.settled.add(id);
        continue;
      }
      // The other targets still start; the refusal names the parked one once they have.
      const reason = await this.processes.parkedReason?.(binding);
      // A parked binding the operator stopped stays out of an unscoped start.
      if (reason && (workspaceId || binding.enabled))
        progress.refused ??= new WorkspaceParkedError(id, reason);
      if (reason) {
        progress.settled.add(id);
        continue;
      }
      try {
        if (await this.#startForOperator(operation, binding, requestId, options))
          progress.started.push(id);
      } catch (error) {
        // It parked as it started (the cloud refused it at once): the rest still start.
        if (!(error instanceof WorkspaceParkedError)) throw error;
        progress.refused ??= error;
      }
      progress.settled.add(id);
    }
    if (progress.refused) throw progress.refused;
    return { started: progress.started, pending: [] };
  }

  /**
   * Settles with `work` if it finishes by `deadline`, otherwise with `early()`. Work that outlives
   * the answer keeps running; a later failure is logged, since nobody is waiting for it any more.
   * The timer is always cleared (see `answeredWithin` for why a leftover one matters).
   */
  async #answerBy<T>(deadline: number, work: Promise<T>, early: () => T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), Math.max(0, deadline - this.now()));
    });
    try {
      const first = await Promise.race([work.then(() => "finished" as const), expired]);
      if (first === "finished") return work;
    } finally {
      clearTimeout(timer);
    }
    work.catch((error: unknown) => {
      logger.warn("A lifecycle command failed after it had already answered", {
        event: "lifecycle:command_failed_after_answer",
        error_message: error instanceof Error ? error.message : String(error),
      });
    });
    return early();
  }

  /** Resolves false for a restart this request already completed (nothing started). */
  async #startForOperator(
    operation: "start" | "restart",
    binding: ManagedBinding,
    requestId: string | undefined,
    options: CommandOptions,
  ): Promise<boolean> {
    // Reached only for "start" and "restart": an explicit operator lifecycle command, the one
    // seam that is allowed to clear the health latch (see `WorkspaceProcesses.clearHealth`).
    await this.processes.clearHealth?.(binding);
    if (operation === "restart") {
      const id = requestId ?? crypto.randomUUID();
      const result = binding.restartResults?.find((entry) => entry.requestId === id);
      if (result?.status === "cancelled")
        throw new Error("Workspace restart was cancelled by stop");
      if (result) return false;
      if (binding.restart && binding.restart.requestId !== id)
        throw new Error(
          `Workspace ${binding.workspaceId} has an unfinished restart. Run 'coforge-computer start --workspace ${binding.workspaceId}' to finish it, then restart again.`,
        );
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
      await this.#advanceRestart(binding, options);
    } else if (binding.restart) await this.#advanceRestart(binding, options);
    else await this.#start(await this.#saveBinding({ ...binding, enabled: true }));
    return true;
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
          throw new UpgradeOperationPendingError(
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
      await this.#refresh();
      await this.#reconcileBindings();
    });
  }
  shutdown() {
    return this.#serialize(async () => {
      for (const binding of this.#bindings) await this.#stop(binding);
    });
  }

  async #reconcileBindings(): Promise<void> {
    const failures: Error[] = [];
    for (const workspaceId of this.#bindings.map((binding) => binding.workspaceId)) {
      await this.#refresh();
      const binding = this.#bindings.find((entry) => entry.workspaceId === workspaceId)!;
      try {
        if (!binding.enabled) await this.#stop(binding);
        else if (await this.processes.parkedReason?.(binding)) continue;
        else if (binding.restart) await this.#advanceRestart(binding);
        else await this.#start(binding);
      } catch (cause) {
        failures.push(new Error(`Workspace ${workspaceId} recovery failed`, { cause }));
      }
    }
    if (failures.length)
      throw new WorkspaceRecoveryError(failures, "Workspace recovery incomplete");
  }

  async #advanceRestart(binding: ManagedBinding, options: CommandOptions = {}): Promise<void> {
    const restart = binding.restart!;
    if (restart.phase === "stopping") {
      const current = await this.processes.instance(binding);
      // The same stable OS unit may already have replaced its failed invocation.
      // start below still validates the replacement through its scoped handshake.
      if (current === null || current === restart.previousInstanceId) {
        // Only a live instance is worth holding; a dead one has no Agents left to drain.
        if (current !== null) await this.#holdRunners(binding, options.deadline);
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
   * Bounded runner hold before a restart stops a live Workspace daemon. Without it
   * `#stop` hands the Agents the ~2s SIGTERM/SIGKILL ladder in `DaemonRuntime.stop()`, which is
   * not enough for a tool call. Only `restart` holds: `stop` is an operator saying "now".
   *
   * Nothing releases the hold afterwards, and nothing needs to. It is in-memory in the Workspace
   * daemon and `#stop` kills that process; the replacement is born without a hold
   * (the hold is never persisted). The one exception is a stop that fails: the daemon survives
   * held, so `#advanceRestart` releases it before rethrowing; a later retry re-asks, which is
   * idempotent.
   *
   * The wait runs inside the serialized mutation, so other lifecycle commands queue behind it for
   * up to `RUNNER_HOLD_MS`. That is accepted: an upgrade's `pauseLaunches` already blocks the same
   * queue for as long, and a restart that raced ahead of the drain would defeat the point. An
   * operator restart's hold draws from what is left of its command's deadline instead.
   *
   * Every failure resolves towards proceeding: `holdRunnersUntilQuiescent` reports quiescent when
   * the hold cannot be asked at all, and a Workspace that answers `accepted: false` or times out
   * is counted as idle. A restart is never failed because of the hold.
   */
  async #holdRunners(binding: ManagedBinding, deadline?: number): Promise<void> {
    if (!this.processes.hold) return;
    const holdMs = this.restartHold.holdMs ?? RUNNER_HOLD_MS;
    const outcome = await holdRunnersUntilQuiescent({
      hold: () => this.processes.hold!(binding, "restart"),
      ...this.restartHold,
      holdMs:
        deadline === undefined ? holdMs : Math.min(holdMs, Math.max(0, deadline - this.now())),
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
    // `#paused` is set only by an in-flight Computer upgrade (`daemon:pause`/the launch-hold
    // file), so every caller of this guard - configure, command, and recordUpgrade - is refusing
    // for that one reason.
    if (this.#paused)
      throw new UpgradeLaunchesPausedError("machine lifecycle is paused for upgrade");
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
