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
