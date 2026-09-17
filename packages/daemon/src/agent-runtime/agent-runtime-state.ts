import type {
  AgentControlScope,
  AgentControlResult,
  AgentSessionSnapshot,
  SessionIdentity,
} from "@lrm/coforge-sdk/internal";

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
  /**
   * Set only when a Stop or a launch-failure cleanup could not confirm the local process
   * actually exited (see `AgentProcessCleanupError`). Optional so existing on-disk version-1
   * records without it keep parsing; absent/false means the process's exit status is trustworthy,
   * so a live-phase record left behind by a gone daemon instance is safe to repair rather than
   * fence forever (docs/adr/0033).
   */
  exitUnconfirmed?: boolean;
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
