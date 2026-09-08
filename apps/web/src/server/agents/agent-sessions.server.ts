import type { AgentSessionReport, AgentStartIntent } from "@coforge/protocol";

export type RuntimeSessionReference = {
  provider: string;
  computerId: string;
  sessionId?: string;
  sessionMode?: "create" | "resume";
  startRequestId: string;
  daemonInstanceId: string;
  launchId?: string;
};

export interface AgentSessionRepository {
  read(agentId: string): Promise<
    | {
        workspaceId: string;
        computerId?: string;
        provider: string;
        reference: RuntimeSessionReference | null;
      }
    | undefined
  >;
  replace(
    agentId: string,
    previous: RuntimeSessionReference | null,
    next: RuntimeSessionReference,
  ): Promise<boolean>;
}

/** Cloud owns selection; CAS fencing prevents a retired launch from changing it. */
export class AgentSessions {
  constructor(
    private readonly repository: AgentSessionRepository,
    private readonly currentDaemon: (
      workspaceId: string,
      computerId: string,
    ) => Promise<string | undefined>,
  ) {}

  async prepare(intent: AgentStartIntent): Promise<AgentStartIntent> {
    const agent = await this.repository.read(intent.agentId);
    if (
      !agent ||
      agent.workspaceId !== intent.workspaceId ||
      agent.computerId !== intent.computerId ||
      agent.provider !== intent.provider
    )
      throw new Error("Agent session start scope is not authorized");
    const daemonInstanceId = await this.currentDaemon(intent.workspaceId, intent.computerId);
    if (!daemonInstanceId) throw new Error("Workspace daemon identity is unavailable");
    const old = agent.reference;
    const compatible = old?.provider === intent.provider && old.computerId === intent.computerId;
    const sessionId =
      intent.sessionId ??
      (compatible ? old?.sessionId : undefined) ??
      (intent.provider === "coforge" ? crypto.randomUUID() : undefined);
    const sessionMode =
      intent.sessionMode ??
      (intent.sessionId
        ? "resume"
        : compatible && old.sessionId
          ? (old.sessionMode ?? "resume")
          : "create");
    if (sessionMode === "resume" && !sessionId)
      throw new Error("Agent resume requires a session ID");
    if (
      compatible &&
      old.daemonInstanceId === daemonInstanceId &&
      intent.sessionId &&
      intent.sessionId !== old.sessionId
    )
      throw new Error("Stop the Agent before selecting a different session");
    // A repeated start is a wake, not a replacement of a live or pending launch.
    if (
      compatible &&
      old.daemonInstanceId === daemonInstanceId &&
      (!intent.sessionId || intent.sessionId === old.sessionId)
    )
      return {
        ...intent,
        requestId: old.startRequestId,
        previousLaunchId: old.launchId,
        sessionMode: old.sessionMode ?? sessionMode,
        ...(sessionId ? { sessionId } : {}),
      };
    const next: RuntimeSessionReference = {
      provider: intent.provider,
      computerId: intent.computerId,
      sessionId,
      sessionMode,
      startRequestId: intent.requestId,
      daemonInstanceId,
      ...(compatible &&
      old?.startRequestId === intent.requestId &&
      old.daemonInstanceId === daemonInstanceId
        ? { launchId: old.launchId }
        : {}),
    };
    if (!(await this.repository.replace(intent.agentId, old, next)))
      throw new Error("Agent session selection changed concurrently");
    return {
      ...intent,
      previousLaunchId: undefined,
      sessionMode,
      ...(sessionId ? { sessionId } : {}),
    };
  }

  async accept(report: AgentSessionReport): Promise<void> {
    const agent = await this.repository.read(report.agentId);
    const old = agent?.reference;
    if (
      !agent ||
      agent.workspaceId !== report.workspaceId ||
      agent.computerId !== report.computerId ||
      agent.provider !== report.provider ||
      !old ||
      old.provider !== report.provider ||
      old.computerId !== report.computerId ||
      old.startRequestId !== report.startRequestId ||
      old.daemonInstanceId !== report.daemonInstanceId ||
      (old.launchId &&
        old.launchId !== report.launchId &&
        old.launchId !== report.previousLaunchId) ||
      (old.sessionId &&
        old.sessionId !== report.sessionId &&
        old.sessionId !== report.replacedSessionId) ||
      (await this.currentDaemon(report.workspaceId, report.computerId)) !== report.daemonInstanceId
    )
      throw new Error("Agent session report is stale or unauthorized");
    if (
      !(await this.repository.replace(report.agentId, old, {
        ...old,
        sessionId: report.sessionId,
        sessionMode: "resume",
        launchId: report.launchId,
      }))
    )
      throw new Error("Agent session identity changed concurrently");
  }

  async retire(agentId: string, workspaceId: string, computerId: string): Promise<void> {
    const agent = await this.repository.read(agentId);
    if (!agent || agent.workspaceId !== workspaceId || agent.computerId !== computerId)
      throw new Error("Agent session stop scope is not authorized");
    const old = agent.reference;
    if (!old) return;
    if (
      !(await this.repository.replace(agentId, old, {
        ...old,
        provider: agent.provider,
        computerId,
        sessionId:
          old.provider === agent.provider && old.computerId === computerId
            ? old.sessionId
            : undefined,
        startRequestId: crypto.randomUUID(),
        daemonInstanceId: "",
        launchId: undefined,
      }))
    )
      throw new Error("Agent session identity changed concurrently");
  }
}
