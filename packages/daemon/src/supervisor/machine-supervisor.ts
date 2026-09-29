import { getLogger } from "@logtape/logtape";
import type { DaemonConnectRejectionReason } from "@lrm/coforge-sdk/internal";
import type { DaemonConfig } from "#src/daemon-runtime/runtime";
import { answeredWithin, holdRunnersUntilQuiescent, type RunnerHoldSnapshot } from "./runner-hold";
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
  /** The last operator command that failed for this Workspace after it had already answered, so
   * `coforge-computer status` can say so; cleared by the next one that succeeds. */
  lastFailure?: LifecycleFailure;
};

export type LifecycleFailure = {
  operation: "start" | "restart" | "stop";
  message: string;
  at: number;
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

/** What one command has got through so far, read when its deadline answers before it finishes:
 * its targets are handled in order, so the first `done` of them are finished. */
type CommandProgress = {
  targets?: string[];
  done: number;
  started: string[];
  refused?: WorkspaceParkedError;
  superseded?: WorkspaceLifecycleSupersededError;
  /** Ends a target's under-way mark once it has been handled. */
  settle(workspaceId: string): void;
};

/**
 * A start or restart a later `stop` or `configure` of the same Workspace took over, as systemd
 * replaces a unit's pending start job with a stop job: the work under way gives up at its next
 * step, and one still queued never runs.
 */
export class WorkspaceLifecycleSupersededError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly by: "stop" | "configure",
    operation?: "start" | "restart",
  ) {
    const work = operation ?? "lifecycle work";
    super(
      by === "stop"
        ? `Workspace ${workspaceId} ${work} was superseded by a stop. Run 'coforge-computer start --workspace ${workspaceId}' to start it again.`
        : `Workspace ${workspaceId} ${work} was superseded by attaching it again, which starts it with its new configuration.`,
    );
    this.name = "WorkspaceLifecycleSupersededError";
  }
}

export interface WorkspaceProcesses {
  /** Gives up with `signal.reason` once `signal` aborts (a stop or configure took over). */
  start(binding: ManagedBinding, options?: { signal?: AbortSignal }): Promise<string>;
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
  /** Start/restart work under way per Workspace; a stop or configure aborts it. */
  #inFlight = new Map<string, AbortController>();
  /** Request order: a stop or configure supersedes every start/restart of its Workspace requested
   * before it (the sequence of the latest one per Workspace). */
  #sequence = 0;
  #supersededAt = new Map<string, { sequence: number; by: "stop" | "configure" }>();
  /** Start/restart/configure requests per Workspace, from request until handled: queued or
   * running, what the view reports as under way. */
  #underWay = new Map<string, number>();
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

  /** Attaches (or re-attaches) a Workspace and starts it. It takes over a start or restart of the
   * same Workspace still under way or queued; a restart it replaces is recorded cancelled. */
  configure(config: DaemonConfig) {
    this.#supersede([config.workspaceId], "configure");
    const settle = this.#markUnderWay([config.workspaceId]);
    const work = this.#serialize(async () => {
      this.#assertMutable();
      await this.#refresh();
      const previous = this.#bindings.find((binding) => binding.workspaceId === config.workspaceId);
      if (previous) await this.#stop(previous);
      const binding = {
        ...config,
        enabled: true,
        restartResults: previous ? cancelledRestartResults(previous) : undefined,
      };
      await this.processes.clearParked?.(binding);
      await this.#saveBinding(binding);
      await this.#track(binding.workspaceId, (signal) => this.#start(binding, signal));
    });
    return work.finally(settle.all);
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
    const requested = this.#targets(operation, workspaceId).map(workspaceIdOf);
    const sequence = operation === "stop" ? this.#supersede(requested, "stop") : ++this.#sequence;
    const settle = this.#markUnderWay(operation === "stop" ? [] : requested);
    const progress: CommandProgress = { done: 0, started: [], settle: settle.one };
    const work = this.#serialize(() =>
      this.#command(operation, workspaceId, requestId, sequence, progress),
    ).finally(settle.all);
    if (options.deadline === undefined) return work;
    const unhandled = () => (progress.targets ?? requested).slice(progress.done);
    return this.#answerBy(
      options.deadline,
      work,
      () => {
        if (progress.refused) throw progress.refused;
        if (progress.superseded) throw progress.superseded;
        return { started: [...progress.started], pending: unhandled() };
      },
      (error) => this.#failedAfterAnswer(operation, unhandled(), error),
    );
  }

  /**
   * Nobody waits for a command that failed after it answered, so its failure is logged and
   * recorded on the Workspaces it had not handled yet, where `status` shows it. A park or a stop
   * or configure that took over is not a failure of this kind: `status` already shows the park,
   * and the operator asked for the takeover.
   */
  #failedAfterAnswer(
    operation: "start" | "restart" | "stop",
    workspaceIds: readonly string[],
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof WorkspaceParkedError || error instanceof WorkspaceLifecycleSupersededError)
      return;
    logger.warn("A lifecycle command failed after it had already answered", {
      event: "lifecycle:command_failed_after_answer",
      operation,
      workspace_ids: workspaceIds,
      error_message: message,
    });
    void this.#serialize(async () => {
      await this.#refresh();
      for (const id of workspaceIds) {
        const binding = this.#bindings.find((entry) => entry.workspaceId === id);
        if (binding)
          await this.#saveBinding({
            ...binding,
            lastFailure: { operation, message: message.slice(0, 500), at: this.now() },
          });
      }
    }).catch((recordError: unknown) => {
      logger.warn("Recording a lifecycle failure for status failed", {
        event: "lifecycle:failure_record_failed",
        error_message: recordError instanceof Error ? recordError.message : String(recordError),
      });
    });
  }

  /** Drops a Workspace's recorded failure once a lifecycle step for it succeeded. */
  async #clearFailure(workspaceId: string): Promise<void> {
    const binding = this.#bindings.find((entry) => entry.workspaceId === workspaceId);
    if (binding?.lastFailure) await this.#saveBinding({ ...binding, lastFailure: undefined });
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
        /** A start or restart of this Workspace is under way. */
        inFlight:
          this.#inFlight.has(binding.workspaceId) ||
          (this.#underWay.get(binding.workspaceId) ?? 0) > 0,
      })),
    );
  }

  /** Takes over the start/restart work of these Workspaces requested so far; returns this
   * request's sequence. */
  #supersede(workspaceIds: readonly string[], by: "stop" | "configure"): number {
    const sequence = ++this.#sequence;
    for (const id of workspaceIds) {
      this.#supersededAt.set(id, { sequence, by });
      this.#inFlight.get(id)?.abort(new WorkspaceLifecycleSupersededError(id, by));
    }
    return sequence;
  }

  /** Marks these Workspaces under way until each is settled (or all are, once the work ends). */
  #markUnderWay(workspaceIds: readonly string[]) {
    const marked = new Set(workspaceIds);
    for (const id of marked) this.#underWay.set(id, (this.#underWay.get(id) ?? 0) + 1);
    const one = (id: string) => {
      if (!marked.delete(id)) return;
      const count = (this.#underWay.get(id) ?? 1) - 1;
      if (count > 0) this.#underWay.set(id, count);
      else this.#underWay.delete(id);
    };
    return { one, all: () => [...marked].forEach(one) };
  }

  /** Runs one Workspace's start/restart work where a stop or configure can abort it. */
  async #track<T>(workspaceId: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.#inFlight.set(workspaceId, controller);
    try {
      return await run(controller.signal);
    } finally {
      if (this.#inFlight.get(workspaceId) === controller) this.#inFlight.delete(workspaceId);
    }
  }

  /** The Workspaces a command acts on: an unscoped restart leaves disabled bindings alone. */
  #targets(operation: "start" | "stop" | "restart", workspaceId?: string): ManagedBinding[] {
    return this.#bindings.filter(
      (binding) =>
        (!workspaceId || binding.workspaceId === workspaceId) &&
        !(operation === "restart" && !workspaceId && !binding.enabled),
    );
  }

  async #command(
    operation: "start" | "stop" | "restart",
    workspaceId: string | undefined,
    requestId: string | undefined,
    sequence: number,
    progress: CommandProgress,
  ): Promise<CommandAnswer> {
    this.#assertMutable();
    await this.#refresh();
    if (workspaceId && !this.#bindings.some((binding) => binding.workspaceId === workspaceId))
      throw new Error("Workspace is not registered locally");
    const targets = this.#targets(operation, workspaceId);
    progress.targets = targets.map(workspaceIdOf);
    for (let binding of targets) {
      const id = binding.workspaceId;
      if (operation === "stop") {
        binding = await this.#saveBinding({
          ...binding,
          enabled: false,
          restart: undefined,
          restartResults: cancelledRestartResults(binding),
        });
        await this.#stop(binding);
        await this.#clearFailure(id);
      } else {
        // The other targets still start; the refusal names the parked one once they have.
        const reason = await this.processes.parkedReason?.(binding);
        if (reason) {
          // A parked binding the operator stopped stays out of an unscoped start.
          if (workspaceId || binding.enabled)
            progress.refused ??= new WorkspaceParkedError(id, reason);
        } else if ((this.#supersededAt.get(id)?.sequence ?? 0) > sequence) {
          // A stop or configure requested after this command takes precedence.
          const { by } = this.#supersededAt.get(id)!;
          progress.superseded ??= new WorkspaceLifecycleSupersededError(id, by, operation);
        } else {
          try {
            const current = binding;
            if (
              await this.#track(id, (signal) =>
                this.#startForOperator(operation, current, requestId, signal),
              )
            )
              progress.started.push(id);
            await this.#clearFailure(id);
          } catch (error) {
            // It parked as it started (the cloud refused it at once): the rest still start.
            if (error instanceof WorkspaceParkedError) progress.refused ??= error;
            else if (error instanceof WorkspaceLifecycleSupersededError)
              progress.superseded ??= new WorkspaceLifecycleSupersededError(
                id,
                error.by,
                operation,
              );
            else throw error;
          }
        }
      }
      progress.done += 1;
      progress.settle(id);
    }
    if (progress.refused) throw progress.refused;
    if (progress.superseded) throw progress.superseded;
    return { started: progress.started, pending: [] };
  }

  /**
   * Settles with `work` if it finishes by `deadline`, otherwise with `early()`. Work that outlives
   * the answer keeps running; a later failure goes to `late`, since nobody is waiting for it.
   */
  async #answerBy<T>(
    deadline: number,
    work: Promise<T>,
    early: () => T,
    late: (error: unknown) => void,
  ): Promise<T> {
    const finished = await answeredWithin(
      work.then(
        () => true,
        () => true,
      ),
      Math.max(0, deadline - this.now()),
      "lifecycle command deadline",
    ).catch(() => false);
    if (finished) return work;
    work.catch(late);
    return early();
  }

  /** Resolves false for a restart this request already completed (nothing started). */
  async #startForOperator(
    operation: "start" | "restart",
    binding: ManagedBinding,
    requestId: string | undefined,
    signal: AbortSignal,
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
      await this.#advanceRestart(binding, signal);
    } else if (binding.restart) await this.#advanceRestart(binding, signal);
    else await this.#start(await this.#saveBinding({ ...binding, enabled: true }), signal);
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
      return this.view();
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
        else if (binding.restart)
          await this.#track(workspaceId, (signal) => this.#advanceRestart(binding, signal));
        else await this.#track(workspaceId, (signal) => this.#start(binding, signal));
        await this.#clearFailure(workspaceId);
      } catch (cause) {
        failures.push(new Error(`Workspace ${workspaceId} recovery failed`, { cause }));
      }
    }
    if (failures.length)
      throw new WorkspaceRecoveryError(failures, "Workspace recovery incomplete");
  }

  async #advanceRestart(binding: ManagedBinding, signal?: AbortSignal): Promise<void> {
    const restart = binding.restart!;
    if (restart.phase === "stopping") {
      const current = await this.processes.instance(binding);
      // The same stable OS unit may already have replaced its failed invocation.
      // start below still validates the replacement through its scoped handshake.
      if (current === null || current === restart.previousInstanceId) {
        // Only a live instance is worth holding; a dead one has no Agents left to drain.
        if (current !== null) await this.#holdRunners(binding, signal);
        // A stop or configure took over while the Agents drained: it stops the daemon itself.
        signal?.throwIfAborted();
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
    const instanceId = await this.#start(binding, signal);
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
   * operator restart keeps the full bound too: its answer is bounded by its deadline
   * (`#answerBy`), not by cutting the drain short for Agents mid tool call.
   *
   * Every failure resolves towards proceeding: `holdRunnersUntilQuiescent` reports quiescent when
   * the hold cannot be asked at all, and a Workspace that answers `accepted: false` or times out
   * is counted as idle. A restart is never failed because of the hold.
   */
  async #holdRunners(binding: ManagedBinding, signal?: AbortSignal): Promise<void> {
    if (!this.processes.hold) return;
    const outcome = await holdRunnersUntilQuiescent({
      hold: () => this.processes.hold!(binding, "restart"),
      ...this.restartHold,
      ...(signal ? { signal } : {}),
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
  async #start(binding: ManagedBinding, signal?: AbortSignal): Promise<string> {
    const expected = this.#instances.get(binding.workspaceId);
    if (expected && (await this.processes.instance(binding)) === expected) return expected;
    this.#instances.delete(binding.workspaceId);
    signal?.throwIfAborted();
    const instanceId = await this.processes.start(binding, signal ? { signal } : {});
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

const workspaceIdOf = (binding: ManagedBinding) => binding.workspaceId;

/** A binding's restart receipts with its unfinished restart, if any, recorded as cancelled: a
 * stop or a configure replaced it, and a replay of that request must not restart it again. */
function cancelledRestartResults(binding: ManagedBinding): RestartResult[] | undefined {
  if (!binding.restart) return binding.restartResults;
  return [
    ...(binding.restartResults ?? []),
    { requestId: binding.restart.requestId, status: "cancelled" as const },
  ].slice(-128);
}
