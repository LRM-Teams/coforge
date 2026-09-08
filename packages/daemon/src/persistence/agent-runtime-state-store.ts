import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  encodeAgentWorkspaceResetRequest,
  encodeAgentControlResult,
  validateAgentSessionSnapshot,
} from "@coforge/protocol";
import type {
  AgentRuntimeRecord,
  AgentRuntimeStateStore,
} from "../agent-runtime/agent-runtime-state";
import { agentWorkspaceDirectory } from "../agent-runtime/agent-workspace-path";

/** Atomic control and Session state, retaining the existing on-disk path and format. */
export class FileAgentRuntimeStateStore implements AgentRuntimeStateStore {
  constructor(
    private readonly stateDirectory: string,
    private readonly workspaceRoot: string,
    private readonly workspaceId: string,
  ) {
    const state = resolve(stateDirectory);
    const workspace = resolve(workspaceRoot, workspaceId, "agents");
    if (state === workspace || state.startsWith(workspace + sep))
      throw new Error("Agent control state must be outside workspaces");
  }
  private path(agentId: string) {
    agentWorkspaceDirectory(this.workspaceRoot, this.workspaceId, agentId);
    return join(this.stateDirectory, "agent-control", this.workspaceId, `${agentId}.json`);
  }
  async workspaceExists(agentId: string) {
    const path = agentWorkspaceDirectory(this.workspaceRoot, this.workspaceId, agentId);
    await noLinkedAncestors(path);
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return false;
      throw error;
    }
  }
  async listAgentIds() {
    const directory = join(this.stateDirectory, "agent-control", this.workspaceId);
    await noLinkedAncestors(directory);
    try {
      return (await readdir(directory))
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -5));
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
  }
  async read(agentId: string): Promise<AgentRuntimeRecord | undefined> {
    const path = this.path(agentId);
    await noLinkedAncestors(path);
    if (!(await Bun.file(path).exists())) return undefined;
    if (Bun.file(path).size > 131_072) throw new Error("Agent control record is too large");
    const value = await Bun.file(path).json();
    if (
      !value ||
      value.version !== 1 ||
      value.scope?.agentId !== agentId ||
      value.scope.workspaceId !== this.workspaceId ||
      typeof value.daemonInstanceId !== "string" ||
      !["start", "stop", "reset-workspace"].includes(value.action) ||
      ![
        "stopping",
        "clearing",
        "workspace-reset",
        "starting",
        "running",
        "stopped",
        "failed",
      ].includes(value.phase) ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0
    )
      throw new Error("Agent control record is invalid");
    encodeAgentWorkspaceResetRequest(value.scope);
    if (value.stopResult) encodeAgentControlResult(value.stopResult);
    if (value.workspaceResetResult) encodeAgentControlResult(value.workspaceResetResult);
    if (value.startResult) encodeAgentControlResult(value.startResult);
    if (value.lastResult) encodeAgentControlResult(value.lastResult);
    if (value.report) validateAgentSessionSnapshot(value.report);
    return value;
  }
  async write(agentId: string, record: AgentRuntimeRecord) {
    const path = this.path(agentId);
    await noLinkedAncestors(path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      // File mode, atomic rename and fsync require Bun's node:fs compatibility API.
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(record));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async clearWorkspace(agentId: string) {
    const workspace = agentWorkspaceDirectory(this.workspaceRoot, this.workspaceId, agentId);
    await noLinkedAncestors(workspace);
    let entries;
    try {
      entries = await readdir(workspace);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return;
      throw error;
    }
    // The process tree has already stopped. rm unlinks internal symlinks, never their targets.
    for (const entry of entries) await rm(join(workspace, entry), { recursive: true, force: true });
  }
}

async function noLinkedAncestors(path: string): Promise<void> {
  const absolute = resolve(path);
  let current = absolute;
  for (;;) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("Agent control path contains a symbolic link");
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
