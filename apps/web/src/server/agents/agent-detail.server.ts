import type { Prisma } from "../../../generated/client";

type DetailActivity = {
  id: string;
  computerId: string;
  launchId: string;
  clientSeq: number;
  activity: string;
  level: string;
  message: string;
  diagnosticErrorClass?: string | null;
  diagnosticReason?: string | null;
  diagnosticFingerprint?: string | null;
  occurredAt: Date;
  createdAt: Date;
};

type DetailAgent = {
  id: string;
  workspaceId: string;
  name: string;
  displayName: string;
  createdAt: Date;
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
  constructor(private readonly source: AgentDetailSource) {}

  async get(workspaceId: string, agentId: string, userId: string) {
    const agent = await this.source.findAuthorized(workspaceId, agentId, userId);
    if (!agent) return undefined;
    const activity = await this.source.listActivity(workspaceId, agentId);
    const latest = activity[0];
    return {
      ...agent,
      computer: latest
        ? { id: latest.computerId, label: computerLabel(latest.computerId) }
        : undefined,
      latestError: activity.find((entry) => entry.level === "error"),
      activity,
    };
  }
}
