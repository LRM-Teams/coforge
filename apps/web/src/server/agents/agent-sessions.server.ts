import type { AgentSessionReport, AgentStartIntent } from "@coforge/protocol";

export type RuntimeSessionReference = {
  provider: string;
  computerId: string;
  sessionId?: string;
  sessionMode?: "create" | "resume";
  state?: "empty" | "resumable" | "unknown";
  startRequestId: string;
  daemonInstanceId: string;
  launchId?: string;
};
export type AgentSessionWriteScope = Pick<
  AgentStartIntent,
  "workspaceId" | "requestId" | "controlEpoch"
> & { launchId?: string };

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
    scope: AgentSessionWriteScope,
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
    const controlled = intent.controlEpoch !== undefined;
    const sameRequest = compatible && old.startRequestId === intent.requestId;
    // Repeated delivery is the same launch even before its first turn. Empty
    // history selects fresh only for a NEW operation, never for a delayed wake.
    if (compatible && (!controlled || sameRequest) && old.daemonInstanceId === daemonInstanceId) {
      if (!sameRequest && intent.sessionId && intent.sessionId !== old.sessionId)
        throw new Error("Stop the Agent before selecting a different session");
      if (!(await this.repository.replace(intent.agentId, old, old, intent)))
        throw new Error("Agent session selection changed concurrently");
      return {
        ...intent,
        requestId: old.startRequestId,
        previousLaunchId: old.launchId,
        sessionMode: old.sessionMode ?? (old.sessionId ? "resume" : "create"),
        sessionId: old.sessionId,
      };
    }
    const sessionId =
      intent.sessionId ??
      (compatible && (!controlled || sameRequest) && old.state !== "empty"
        ? old.sessionId
        : undefined) ??
      (intent.provider === "coforge" ? crypto.randomUUID() : undefined);
    const sessionMode =
      (sameRequest && old.sessionId === sessionId ? old.sessionMode : undefined) ??
      intent.sessionMode ??
      (intent.sessionId
        ? "resume"
        : compatible && old.sessionId && old.state !== "empty" && (!controlled || sameRequest)
          ? (old.sessionMode ?? "resume")
          : "create");
    if (sessionMode === "resume" && !sessionId)
      throw new Error("Agent resume requires a session ID");
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
    if (!(await this.repository.replace(intent.agentId, old, next, intent)))
      throw new Error("Agent session selection changed concurrently");
    return {
      ...intent,
      previousLaunchId: undefined,
      sessionMode,
      ...(sessionId ? { sessionId } : {}),
    };
  }

  async verify(report: AgentSessionReport) {
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
    return old;
  }

  async accept(report: AgentSessionReport): Promise<void> {
    const old = await this.verify(report);
    const { state: _observedState, ...reference } = old;
    if (
      !(await this.repository.replace(
        report.agentId,
        old,
        {
          ...reference,
          sessionId: report.sessionId,
          sessionMode: "resume",
          launchId: report.launchId,
          ...(report.sessionState ? { state: report.sessionState } : {}),
        },
        { ...report, requestId: report.startRequestId },
      ))
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
      !(await this.repository.replace(
        agentId,
        old,
        {
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
        },
        { workspaceId, requestId: old.startRequestId },
      ))
    )
      throw new Error("Agent session identity changed concurrently");
  }
}
