import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentRuntimeRecord,
  AgentRuntimeStateStore,
} from "../agent-runtime/agent-runtime-state";
import { agentWorkspaceDirectory } from "../agent-runtime/agent-workspace-path";

/**
 * In-process control state (ADR 0056 task #54 step ②): the record lives exactly as long as the
 * daemon process that owns it. Nothing about an Agent's control operation survives a daemon
 * restart — the server re-dispatches what should still be running (Daemon-ready recovery), so a
 * stale operation can no longer outlive the writer it was waiting on, and the dual-run fence is
 * boot process cleanup (task #54 step ①) rather than a persisted record.
 *
 * `workspaceExists` and `clearWorkspace` are still real filesystem operations: they describe the
 * Agent's workspace directory, not the record. The record store and the workspace are only
 * coupled through reset-workspace, which stops the process tree first and then empties the
 * directory — exactly as the file-backed store did.
 */
export class MemoryAgentRuntimeStateStore implements AgentRuntimeStateStore {
  readonly #records = new Map<string, AgentRuntimeRecord>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly workspaceId: string,
  ) {}

  async workspaceExists(agentId: string) {
    const path = agentWorkspaceDirectory(this.workspaceRoot, this.workspaceId, agentId);
    try {
      await readdir(path);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return false;
      throw error;
    }
  }

  async listAgentIds() {
    return [...this.#records.keys()];
  }

  async read(agentId: string) {
    return this.#records.get(agentId) && structuredClone(this.#records.get(agentId)!);
  }

  async write(agentId: string, record: AgentRuntimeRecord) {
    this.#records.set(agentId, structuredClone(record));
  }

  async clearWorkspace(agentId: string) {
    const workspace = agentWorkspaceDirectory(this.workspaceRoot, this.workspaceId, agentId);
    let entries;
    try {
      entries = await readdir(workspace);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return;
      throw error;
    }
    // The process tree has already stopped. rm unlinks internal symlinks, never their targets.
    // One undeletable entry must not leave the rest of the workspace in place: continue past a
    // failing entry, collecting the first error, then throw so the caller logs and flags a warning.
    let firstError: unknown;
    for (const entry of entries) {
      try {
        await rm(join(workspace, entry), { recursive: true, force: true });
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
}
