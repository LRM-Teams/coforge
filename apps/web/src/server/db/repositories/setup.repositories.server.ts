import type { PrismaClient } from "../../../../generated/client";
import type { ComputerRegisterRequest } from "@coforge/protocol";
import type { AuthenticatedPrincipal, Workspace } from "../../computers/registration.server";
import type {
  ComputerConnectionRepository,
  WorkspaceAccess,
} from "../../computers/registration.server";
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
      where: { slug, members: { some: { externalUserId: principal.userId } } },
      select: workspaceShape,
    });
    return row ? mapWorkspace(row) : undefined;
  }
  async getAccessibleBySlug(slug: string, principal: AuthenticatedPrincipal) {
    return this.findAccessibleBySlug(slug, principal);
  }
  async listAccessible(principal: AuthenticatedPrincipal) {
    const rows = await this.db.workspace.findMany({
      where: { members: { some: { externalUserId: principal.userId } } },
      select: workspaceShape,
      orderBy: { slug: "asc" },
    });
    return rows.map(mapWorkspace);
  }
}

export class PrismaComputerConnectionRepository implements ComputerConnectionRepository {
  constructor(private readonly db: PrismaClient) {}
  async create({
    principal,
    workspace,
    request,
  }: {
    principal: AuthenticatedPrincipal;
    workspace: Workspace;
    request: ComputerRegisterRequest;
  }) {
    const computer = await this.db.computer.upsert({
      where: {
        ownerUserId_machineId: { ownerUserId: principal.userId, machineId: request.machineId },
      },
      create: { ownerUserId: principal.userId, machineId: request.machineId },
      update: {},
    });
    const connection = await this.db.workspaceComputer.upsert({
      where: { workspaceId_computerId: { workspaceId: workspace.id, computerId: computer.id } },
      create: { workspaceId: workspace.id, computerId: computer.id },
      update: {},
    });
    return { computerId: computer.id, workspaceId: workspace.id, connectionId: connection.id };
  }
}
