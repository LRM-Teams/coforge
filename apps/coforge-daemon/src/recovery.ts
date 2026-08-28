import type { WorkspaceRegistry } from "./persistence/workspace-registry";
import type { WorkspaceConnection } from "./workspace-worker/supervisor";

export async function recoverWorkspaceConnections(
  registry: Pick<WorkspaceRegistry, "list" | "upsert" | "delete">,
  supervisor: {
    ensure?: (connection: WorkspaceConnection) => Promise<unknown>;
    configureWorkspaceWorker?: (connection: WorkspaceConnection) => Promise<void>;
  },
  report = (line: string) => console.error(line),
): Promise<void> {
  for (const connection of await registry.list()) {
    try {
      if (supervisor.ensure) await supervisor.ensure(connection);
      else if (supervisor.configureWorkspaceWorker)
        await supervisor.configureWorkspaceWorker(connection);
      else throw new Error("workspace worker command is unavailable");
    } catch {
      report(`coforge-daemon: failed to recover workspace ${connection.workspaceId}`);
    }
  }
}
