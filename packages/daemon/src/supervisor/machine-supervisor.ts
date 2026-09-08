import type { DaemonConfig } from "../daemon-runtime/runtime";

export type RestartProgress = {
  requestId: string;
  phase: "stopping" | "starting";
  previousInstanceId: string | null;
};
export type RestartResult =
  | { requestId: string; status: "completed"; instanceId: string }
  | { requestId: string; status: "cancelled" };
export type ManagedBinding = DaemonConfig & {
  enabled: boolean;
  restart?: RestartProgress;
  restartResults?: RestartResult[];
  /** Legacy cloud ready hints, never proof of a completed local operation. */
  restartRequestIds?: string[];
};
export class WorkspaceRecoveryError extends AggregateError {}
export interface BindingStore {
  load(): Promise<ManagedBinding[]>;
  save(bindings: ManagedBinding[]): Promise<void>;
}
export interface WorkspaceProcesses {
  start(binding: ManagedBinding): Promise<string>;
  stop(binding: ManagedBinding): Promise<void>;
  instance(binding: ManagedBinding): Promise<string | null>;
}

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
      if (current === null || current === restart.previousInstanceId) await this.#stop(binding);
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
