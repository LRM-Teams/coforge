import type { Prisma } from "../../../generated/client";
import { latestActivityError, type ActivityEntry } from "../../features/agents/agent-activity";
import type { AgentStatusCache } from "./agent-status.server";
import type { AgentDisplay } from "./agent-display.server";
import type { AgentDisplaySnapshot } from "@coforge/protocol/agent-display";

type DetailActivity = ActivityEntry & { computerId: string };

type DetailAgent = {
  id: string;
  workspaceId: string;
  name: string;
  displayName: string;
  description?: string;
  createdAt: Date;
  computerId?: string | null;
  owner: { id: string; username: string };
  runtimeConfig: Prisma.JsonValue;
};

export type AgentDetailSource = {
  findAuthorized(
    workspaceId: string,
    agentId: string,
    userId: string,
  ): Promise<DetailAgent | undefined>;
  listActivity(workspaceId: string, agentId: string): Promise<DetailActivity[]>;
};

function computerLabel(id: string) {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
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
    const latest = activity[0];
    return {
      ...agent,
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
      computer: latest
        ? { id: latest.computerId, label: computerLabel(latest.computerId) }
        : undefined,
      latestError: latestActivityError(activity),
      activity,
    };
  }
}
