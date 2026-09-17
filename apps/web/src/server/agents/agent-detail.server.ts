import type { Prisma } from "../../../generated/client";
import { latestActivityError, type ActivityEntry } from "../../features/agents/agent-activity";
import type { AgentStatusCache } from "./agent-status.server";
import type { AgentDisplay } from "./agent-display.server";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

type DetailActivity = ActivityEntry & { computerId: string };

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
  owner: { id: string; username: string; displayName?: string | null };
  runtimeConfig: Prisma.JsonValue;
  weeklyReportAssistant?: { id: string } | null;
  /** Set when a user stopped this Agent (ADR 0038). */
  stoppedAt?: Date | null;
};

export type AgentDetailSource = {
  findAuthorized(
    workspaceId: string,
    agentId: string,
    userId: string,
  ): Promise<DetailAgent | undefined>;
  listActivity(workspaceId: string, agentId: string): Promise<DetailActivity[]>;
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
    const activity = await this.source.listActivity(workspaceId, agentId);
    let status;
    let statusReadFailed = false;
    let display: AgentDisplaySnapshot | undefined;
    if (agent.computerId && this.status) {
      try {
        status = await this.status.snapshot({
          workspaceId,
          computerId: agent.computerId,
          agentId,
        });
      } catch {
        statusReadFailed = true;
      }
    }
    if (agent.computerId && this.display) {
      try {
        display = await this.display.snapshot({
          workspaceId,
          computerId: agent.computerId,
          agentId,
        });
      } catch {
        // Display is an optional read model; unavailable is not equivalent to offline.
      }
    }
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
      latestError: latestActivityError(activity),
      activity,
    };
  }
}
