import type { Prisma } from "#src/generated/prisma/client";
import type { AgentStatusCache } from "./agent-status.server";
import type { AgentDisplay } from "./agent-display.server";

type DetailComputer = {
  id: string;
  name: string;
  displayName: string;
  kind: string;
  /** Last-observed Computer executable version (`server/computers/computer-metadata.server.ts`).
   * Surfaced only in the Agent profile panel's Computer meta line; the full detail page does not
   * render it today. */
  computerVersion?: string | null;
};

type DetailAgent = {
  id: string;
  workspaceId: string;
  name: string;
  displayName: string;
  description?: string;
  role: string;
  createdAt: Date;
  computerId?: string | null;
  computer?: DetailComputer | null;
  owner: {
    id: string;
    username: string;
    displayName?: string | null;
    avatarObjectKey?: string | null;
  };
  runtimeConfig: Prisma.JsonValue;
  weeklyReportAssistant?: { id: string } | null;
  /** Set when a user stopped this Agent. */
  stoppedAt?: Date | null;
  /** Who can see this Agent; optional so a caller that has not started selecting it
   * yet still satisfies this type. */
  visibility?: string;
  avatarObjectKey?: string | null;
};

export type AgentDetailSource = {
  findAuthorized(
    workspaceId: string,
    agentId: string,
    userId: string,
  ): Promise<DetailAgent | undefined>;
};

function assignedComputer(agent: DetailAgent) {
  const computer = agent.computer;
  if (!agent.computerId || !computer) return undefined;
  return {
    id: computer.id,
    label: computer.displayName.trim() || computer.name.trim(),
    kind: computer.kind,
    computerVersion: computer.computerVersion ?? null,
  };
}

export class AgentDetailQuery {
  constructor(
    private readonly source: AgentDetailSource,
    private readonly status?: Pick<AgentStatusCache, "snapshot">,
    private readonly display?: Pick<AgentDisplay, "snapshot">,
  ) {}

  async get(workspaceId: string, agentId: string, userId: string) {
    const agent = await this.source.findAuthorized(workspaceId, agentId, userId);
    if (!agent) return undefined;
    // The two reads are independent stores, so they overlap rather than queue: the page waits for
    // the slower of the two, not for both in turn. Each keeps its own failure mode — a failed
    // status read is reported as unknown, and a failed display read just loses the display block.
    const scope = agent.computerId
      ? { workspaceId, computerId: agent.computerId, agentId }
      : undefined;
    let statusReadFailed = false;
    const [status, display] = await Promise.all([
      scope && this.status
        ? this.status.snapshot(scope).catch(() => {
            statusReadFailed = true;
            return undefined;
          })
        : undefined,
      scope && this.display ? this.display.snapshot(scope).catch(() => undefined) : undefined,
    ]);
    const assigned = assignedComputer(agent);
    return {
      id: agent.id,
      workspaceId: agent.workspaceId,
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      role: agent.role,
      createdAt: agent.createdAt,
      computerId: agent.computerId,
      owner: agent.owner,
      runtimeConfig: agent.runtimeConfig,
      isWeeklyReportAssistant: Boolean(agent.weeklyReportAssistant),
      stopped: Boolean(agent.stoppedAt),
      visibility: agent.visibility,
      avatarObjectKey: agent.avatarObjectKey ?? null,
      ...(display ? { display } : {}),
      status: {
        value: statusReadFailed ? ("unknown" as const) : (status?.status ?? ("inactive" as const)),
        expiresAt: status?.expiresAt ?? null,
        ordering: status
          ? {
              daemonInstanceId: status.daemonInstanceId,
              clientSeq: status.clientSeq,
              observedAtMs: status.observedAtMs,
            }
          : null,
      },
      computer: assigned,
    };
  }
}
