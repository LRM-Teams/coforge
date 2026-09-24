import type { PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { enrollGeneralChannel } from "#src/server/conversations/public-channels.server";
import {
  parseAgentRuntimeConfig,
  type AgentRuntimeConfig,
} from "#src/server/agents/agent-runtime-config.server";
import { AGENT_VISIBILITY, type AgentVisibility } from "#src/features/agents/agent-visibility";

export type { AgentRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";

export type AgentRecord = {
  id: string;
  workspaceId: string;
  name: string;
  displayName: string;
  description?: string;
  createdAt: Date;
  ownerId: string;
  computerId?: string;
  runtimeConfig: AgentRuntimeConfig;
  /** Set when a user stopped this Agent; undefined/null means not stopped. Config,
   * credential and environment mutations read this to skip the stop→…→start dance. */
  stoppedAt?: Date | null;
  /** Set when a user deleted this Agent; undefined/null means live. Only the
   * deletion module and the deleted-sender message projection read this. */
  deletedAt?: Date | null;
  /** Optional on this shared record type — every creation path but the weekly-report
   * Collector (created `"private"`) still omits it and gets the schema's `"public"` default. A
   * row actually read through `mapAgent` always carries a real value — `"public"` unless the
   * persisted column reads exactly `"private"`, which fails closed the same way
   * `canSeeAgent`/`visibleAgentWhere` treat an unrecognized value as not-public. Realtime call
   * sites that need a guaranteed value still read it through their own required
   * `agentVisibility` dependency (see `agent-activity-publish.server.ts` and siblings), never by
   * trusting this field to be present on a hand-built fixture elsewhere in the codebase. */
  visibility?: AgentVisibility;
  /** Current picture in the shared image store. Absent means no picture, not a missing column. */
  avatarObjectKey?: string | null;
  avatarContentType?: string | null;
};

function mapAgent(agent: {
  id: string;
  workspaceId: string;
  name: string;
  displayName: string;
  description?: string;
  createdAt: Date;
  ownerId: string;
  computerId: string | null;
  runtimeConfig: unknown;
  runtimeSession?: unknown;
  stoppedAt?: Date | null;
  deletedAt?: Date | null;
  visibility?: string;
  avatarObjectKey?: string | null;
  avatarContentType?: string | null;
}): AgentRecord {
  let runtimeConfig;
  try {
    runtimeConfig = parseAgentRuntimeConfig(agent.runtimeConfig);
  } catch {
    throw new Error(`Agent ${agent.id} has invalid runtime config`);
  }
  const { computerId, description } = agent;
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    name: agent.name,
    displayName: agent.displayName,
    createdAt: agent.createdAt,
    ownerId: agent.ownerId,
    description: description ?? "",
    ...(computerId ? { computerId } : {}),
    runtimeConfig,
    stoppedAt: agent.stoppedAt ?? null,
    deletedAt: agent.deletedAt ?? null,
    // A real row's column is `NOT NULL DEFAULT 'public'`, so `agent.visibility` is always a real
    // string in production; a hand-built fixture that omits it reads as `"public"`, matching the
    // column's own default. Anything else — including an unrecognized persisted value — fails
    // closed to `"private"`, the same way `canSeeAgent`/`visibleAgentWhere` do.
    visibility:
      agent.visibility === undefined || agent.visibility === AGENT_VISIBILITY.PUBLIC
        ? AGENT_VISIBILITY.PUBLIC
        : AGENT_VISIBILITY.PRIVATE,
    avatarObjectKey: agent.avatarObjectKey ?? null,
    avatarContentType: agent.avatarContentType ?? null,
  };
}

export interface AgentRepository {
  getById(id: string): Promise<AgentRecord | undefined>;
  listInWorkspace(workspaceId: string): Promise<AgentRecord[]>;
  listForComputer(workspaceId: string, computerId: string): Promise<AgentRecord[]>;
  /** Deleted Agents still assigned to one Computer: recovery stops these rather than
   * starting them, so a delete whose Stop never reached an offline Daemon is reconciled. */
  listDeletedForComputer(workspaceId: string, computerId: string): Promise<AgentRecord[]>;
  listOwnedInWorkspace(workspaceId: string, ownerId: string): Promise<AgentRecord[]>;
  create(input: Omit<AgentRecord, "id" | "createdAt"> & { id?: string }): Promise<AgentRecord>;
  /** `name` (the @mention username) is fixed at creation and is never part of an update. */
  update(
    id: string,
    input: Pick<AgentRecord, "displayName" | "description"> &
      Partial<Pick<AgentRecord, "runtimeConfig" | "computerId">>,
  ): Promise<AgentRecord>;
}

export class PrismaAgentRepository implements AgentRepository {
  constructor(private readonly db: PrismaClient) {}

  /**
   * The raw row, deliberately *not* filtered by `ACTIVE_AGENT_WHERE`: control, session and
   * deletion code must be able to observe a deleted Agent to keep it inert, and every caller that
   * serves a live view applies `ACTIVE_AGENT_WHERE` itself.
   */
  async getById(id: string) {
    const agent = await this.db.agent.findUnique({ where: { id } });
    return agent ? mapAgent(agent) : undefined;
  }

  async listInWorkspace(workspaceId: string) {
    const agents = await this.db.agent.findMany({
      where: { workspaceId, ...ACTIVE_AGENT_WHERE },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return agents.map(mapAgent);
  }

  async listForComputer(workspaceId: string, computerId: string) {
    const agents = await this.db.agent.findMany({
      where: { workspaceId, computerId, ...ACTIVE_AGENT_WHERE },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return agents.map(mapAgent);
  }

  async listDeletedForComputer(workspaceId: string, computerId: string) {
    const agents = await this.db.agent.findMany({
      where: { workspaceId, computerId, deletedAt: { not: null } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return agents.map(mapAgent);
  }

  async listOwnedInWorkspace(workspaceId: string, ownerId: string) {
    const agents = await this.db.agent.findMany({
      where: { workspaceId, ownerId, ...ACTIVE_AGENT_WHERE },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return agents.map(mapAgent);
  }

  async create(input: Omit<AgentRecord, "id" | "createdAt"> & { id?: string }) {
    return this.db.$transaction(async (tx) => {
      // Free the name slot first if a soft-deleted Agent holds it: `@@unique([workspaceId, name])`
      // also spans deleted rows, so a new Agent with a deleted one's name could never be created.
      // The rename is checked before the create (a failed statement would poison this
      // transaction). The deleted row is hidden from every directory and its name can never come
      // back, so the id-suffixed rename is invisible and keeps renamed rows distinct from each
      // other; history keeps referencing the deleted row by id, so nothing is inherited. A live
      // holder keeps its name — the plain duplicate-name create error still applies.
      const deletedHolder = await tx.agent.findFirst({
        where: { workspaceId: input.workspaceId, name: input.name, deletedAt: { not: null } },
        select: { id: true },
      });
      if (deletedHolder)
        await tx.agent.update({
          where: { id: deletedHolder.id },
          data: { name: `${input.name}-deleted-${deletedHolder.id}` },
        });
      const agent = mapAgent(await tx.agent.create({ data: input }));
      // #general holds every public Agent from the start (a private one never): the enrollment
      // brings the whole Workspace's #general membership up to date, this Agent included.
      await enrollGeneralChannel(tx, input.workspaceId);
      return agent;
    });
  }

  async update(
    id: string,
    input: Pick<AgentRecord, "displayName" | "description"> &
      Partial<Pick<AgentRecord, "runtimeConfig" | "computerId">>,
  ) {
    return mapAgent(await this.db.agent.update({ where: { id }, data: input }));
  }
}

export class RepositoryAgentAuthorization {
  constructor(private readonly agents: AgentRepository) {}

  async canUseAgent(workspaceId: string, agentId: string, userId: string) {
    const agent = await this.agents.getById(agentId);
    return agent?.workspaceId === workspaceId && agent.ownerId === userId;
  }

  async computerIdForAuthorizedAgent(workspaceId: string, agentId: string, userId: string) {
    const agent = await this.agents.getById(agentId);
    if (agent?.workspaceId !== workspaceId || agent.ownerId !== userId) return undefined;
    return agent.computerId;
  }
}
