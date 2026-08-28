import type { WorkspaceConnectionRegistry } from "./persistence/workspace-connection-registry";
import type { DaemonCoordinator } from "./daemon-coordinator";

export async function recoverWorkspaceConnections(
  registry: WorkspaceConnectionRegistry,
  coordinator: Pick<DaemonCoordinator, "configureWorkspaceWorker">,
  report = (line: string) => console.error(line),
): Promise<void> {
  for (const connection of await registry.list()) {
    try {
      await coordinator.configureWorkspaceWorker(connection);
    } catch {
      report(`coforge-daemon: failed to recover workspace ${connection.workspaceId}`);
    }
  }
}
