import type { PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "../../agents/active-agent.server";
import type { CoforgeMemoryActor } from "../../openviking/contract";
import type {
  MappedIdentityWriter,
  WorkspaceIdentityDirectory,
} from "../../workspace-memory/runtime-provisioner";

export class PrismaWorkspaceMemoryIdentityDirectory
  implements WorkspaceIdentityDirectory, MappedIdentityWriter
{
  constructor(private readonly db: PrismaClient) {}

  async listActors(workspaceId: string): Promise<readonly CoforgeMemoryActor[]> {
    const [members, agents] = await Promise.all([
      this.db.workspaceMembership.findMany({
        where: { workspaceId },
        select: { userId: true, role: true },
      }),
      this.db.agent.findMany({
        where: { workspaceId, ...ACTIVE_AGENT_WHERE },
        select: { id: true },
      }),
    ]);
    const actors: CoforgeMemoryActor[] = [];
    for (const member of members) {
      if (member.role === "owner" || member.role === "admin" || member.role === "member") {
        actors.push({ kind: member.role, userId: member.userId });
      }
    }
    for (const agent of agents) {
      actors.push({ kind: "agent", agentId: agent.id });
    }
    return actors;
  }

  async replaceWorkspaceIdentities(input: {
    workspaceId: string;
    generation: number;
    identities: readonly {
      actorKind: CoforgeMemoryActor["kind"];
      actorSubject: string;
      mappedUserId: string;
      role: string;
      access: string;
    }[];
  }): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.openVikingMappedIdentity.deleteMany({ where: { workspaceId: input.workspaceId } });
      if (input.identities.length === 0) return;
      await tx.openVikingMappedIdentity.createMany({
        data: input.identities.map((identity) => ({
          id: crypto.randomUUID(),
          workspaceId: input.workspaceId,
          actorKind: identity.actorKind,
          actorSubject: identity.actorSubject,
          openvikingUserId: identity.mappedUserId,
          role: identity.role,
          access: identity.access,
          generation: input.generation,
        })),
      });
    });
  }
}
