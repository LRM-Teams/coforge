import type {
  AgentControlScope,
  AgentControlResult,
  AgentSessionSnapshot,
  SessionIdentity,
} from "@coforge/protocol";

/** Existing on-disk shape: control and Session facts commit atomically. */
export type AgentRuntimeRecord = {
  version: 1;
  scope: AgentControlScope;
  action: "start" | "stop" | "reset-workspace";
  phase:
    | "stopping"
    | "clearing"
    | "workspace-reset"
    | "starting"
    | "running"
    | "stopped"
    | "failed";
  daemonInstanceId: string;
  sequence: number;
  identity?: SessionIdentity;
  launchId?: string;
  stopResult?: AgentControlResult;
  workspaceResetResult?: AgentControlResult;
  startResult?: AgentControlResult;
  lastResult?: AgentControlResult;
  report?: AgentSessionSnapshot;
};
export interface AgentRuntimeStateStore {
  listAgentIds(): Promise<string[]>;
  workspaceExists(agentId: string): Promise<boolean>;
  read(agentId: string): Promise<AgentRuntimeRecord | undefined>;
  write(agentId: string, record: AgentRuntimeRecord): Promise<void>;
  clearWorkspace(agentId: string): Promise<void>;
}

/** Shared serialization, not control policy or Session reporting. */
export class AgentRuntimeState {
  readonly #pending = new Map<string, Promise<unknown>>();
  constructor(readonly store: AgentRuntimeStateStore) {}

  run<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#pending.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.#pending.set(id, next);
    void next
      .finally(() => {
        if (this.#pending.get(id) === next) this.#pending.delete(id);
      })
      .catch(() => {});
    return next;
  }
}
