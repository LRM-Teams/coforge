import type { RuntimeProvider } from "@coforge/protocol";

export type ComputerRuntimeRecord = {
  id: string;
  computerId: string;
  ownerId: string;
  provider: RuntimeProvider;
  version: string;
  displayName: string;
  observedAt: Date;
  isPublic: boolean;
};

export interface ComputerRuntimeVisibilityRepository {
  listInWorkspace(workspaceId: string): Promise<ComputerRuntimeRecord[]>;
  findInWorkspace(
    workspaceId: string,
    computerId: string,
    provider: RuntimeProvider,
  ): Promise<ComputerRuntimeRecord | undefined>;
  findByIdInWorkspace(
    workspaceId: string,
    runtimeId: string,
  ): Promise<ComputerRuntimeRecord | undefined>;
  setPublic(runtimeId: string, isPublic: boolean): Promise<unknown>;
}

type RuntimePrincipal = { userId: string; workspaceId: string };

export class ComputerRuntimeVisibility {
  constructor(private readonly runtimes: ComputerRuntimeVisibilityRepository) {}

  async list(principal: RuntimePrincipal) {
    return (await this.runtimes.listInWorkspace(principal.workspaceId)).filter(
      (runtime) => runtime.ownerId === principal.userId || runtime.isPublic,
    );
  }

  async canSelect(principal: RuntimePrincipal, computerId: string, provider: RuntimeProvider) {
    const runtime = await this.runtimes.findInWorkspace(
      principal.workspaceId,
      computerId,
      provider,
    );
    return runtime?.ownerId === principal.userId || runtime?.isPublic === true;
  }

  async isOwner(principal: RuntimePrincipal, computerId: string, provider: RuntimeProvider) {
    const runtime = await this.runtimes.findInWorkspace(
      principal.workspaceId,
      computerId,
      provider,
    );
    return runtime?.ownerId === principal.userId;
  }

  async setPublic(principal: RuntimePrincipal, runtimeId: string, isPublic: boolean) {
    const runtime = await this.runtimes.findByIdInWorkspace(principal.workspaceId, runtimeId);
    if (!runtime || runtime.ownerId !== principal.userId)
      throw new Error("runtime is not owned by the current user");
    await this.runtimes.setPublic(runtimeId, isPublic);
    return { ...runtime, isPublic };
  }
}
