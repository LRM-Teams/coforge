import type { PrismaClient } from "../../../../generated/client";
import type { ComputerRegisterRequest } from "@coforge/protocol";
import type { AuthenticatedPrincipal, Workspace } from "../../computers/registration.server";
import type {
  ComputerRegistrationRepository,
  WorkspaceAccess,
} from "../../computers/registration.server";
import { prepareDaemonApiKey } from "../../auth/daemon-api-key.server";
import type { WorkspaceAccess as QueryWorkspaceAccess } from "../../workspaces/query.server";

const workspaceShape = { id: true, slug: true, name: true } as const;
const mapWorkspace = (value: {
  id: string;
  slug: string;
  name: string;
}): Workspace & { readonly name: string } => value;

export class PrismaWorkspaceAccess implements WorkspaceAccess, QueryWorkspaceAccess {
  constructor(private readonly db: PrismaClient) {}
  async findAccessibleBySlug(slug: string, principal: AuthenticatedPrincipal) {
    const row = await this.db.workspace.findFirst({
      where: { slug, members: { some: { userId: principal.userId } } },
      select: workspaceShape,
    });
    return row ? mapWorkspace(row) : undefined;
  }
  async getAccessibleBySlug(slug: string, principal: AuthenticatedPrincipal) {
    return this.findAccessibleBySlug(slug, principal);
  }
  async listAccessible(principal: AuthenticatedPrincipal) {
    const rows = await this.db.workspace.findMany({
      where: { members: { some: { userId: principal.userId } } },
      select: workspaceShape,
      orderBy: { slug: "asc" },
    });
    return rows.map(mapWorkspace);
  }
}

export class PrismaComputerRegistrationRepository implements ComputerRegistrationRepository {
  constructor(private readonly db: PrismaClient) {}
  async register({
    principal,
    workspace,
    request,
  }: {
    principal: AuthenticatedPrincipal;
    workspace: Workspace;
    request: ComputerRegisterRequest;
  }) {
    return this.db.$transaction(async (tx) => {
      const computer = await tx.computer.upsert({
        where: {
          ownerId_machineId: { ownerId: principal.userId, machineId: request.machineId },
        },
        create: { ownerId: principal.userId, machineId: request.machineId },
        update: {},
      });
      const daemonApiKey = prepareDaemonApiKey({
        principal,
        workspaceId: workspace.id,
        computerId: computer.id,
      });
      const connection = await tx.workspaceComputer.findUnique({
        where: { computerId: computer.id },
        select: { workspaceId: true },
      });
      if (connection && connection.workspaceId !== workspace.id) {
        await Promise.all([
          tx.agent.updateMany({
            where: { computerId: computer.id, workspaceId: { not: workspace.id } },
            data: { computerId: null },
          }),
          tx.computerRuntime.updateMany({
            where: { computerId: computer.id, isPublic: true },
            data: { isPublic: false },
          }),
        ]);
      }
      await tx.workspaceComputer.upsert({
        where: { computerId: computer.id },
        create: { workspaceId: workspace.id, computerId: computer.id },
        update: { workspaceId: workspace.id },
      });
      await tx.daemonApiKey.updateMany({
        where: { computerId: computer.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.daemonApiKey.create({ data: daemonApiKey.record });
      return {
        computerId: computer.id,
        workspaceId: workspace.id,
        daemonApiKey: daemonApiKey.apiKey,
      };
    });
  }
}
