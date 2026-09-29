import type { PrismaClient } from "#src/generated/prisma/client";
import { decodeOpenVikingBinding, type OpenVikingBinding } from "../../openviking/contract";
import type { OpenVikingBindingStore } from "../../openviking/stores";
import {
  isUniqueConstraintError,
  WorkspaceMemoryBindingError,
  WorkspaceMemoryScopeError,
} from "./workspace-memory-errors.server";

export class PrismaOpenVikingBindingStore implements OpenVikingBindingStore {
  constructor(private readonly db: PrismaClient) {}

  async get(workspaceId: string): Promise<OpenVikingBinding | null> {
    const row = await this.db.openVikingBinding.findUnique({ where: { workspaceId } });
    if (!row) return null;
    const decoded = decodeOpenVikingBinding({
      workspaceId: row.workspaceId,
      accountId: row.accountId,
      serviceIdentityId: row.serviceIdentityId,
      credentialRef: row.credentialRef,
      generation: row.generation,
    });
    if ("code" in decoded) throw new WorkspaceMemoryBindingError();
    return decoded;
  }

  async compareAndSet(input: {
    workspaceId: string;
    expectedGeneration: number;
    binding: OpenVikingBinding;
  }): Promise<"saved" | "stale_generation"> {
    if (input.binding.workspaceId !== input.workspaceId) throw new WorkspaceMemoryScopeError();
    const decoded = decodeOpenVikingBinding(input.binding);
    if ("code" in decoded) throw new WorkspaceMemoryBindingError();
    const data = {
      workspaceId: decoded.workspaceId,
      accountId: decoded.accountId,
      serviceIdentityId: decoded.serviceIdentityId,
      credentialRef: decoded.credentialRef,
      generation: decoded.generation,
    };
    try {
      return await this.db.$transaction(async (tx) => {
        const current = await tx.openVikingBinding.findUnique({
          where: { workspaceId: input.workspaceId },
        });
        const currentGeneration = current?.generation ?? 0;
        if (
          currentGeneration !== input.expectedGeneration ||
          decoded.generation < currentGeneration
        ) {
          return "stale_generation";
        }
        if (!current) {
          await tx.openVikingBinding.create({ data });
          return "saved";
        }
        const updated = await tx.openVikingBinding.updateMany({
          where: { workspaceId: input.workspaceId, generation: input.expectedGeneration },
          data: {
            accountId: data.accountId,
            serviceIdentityId: data.serviceIdentityId,
            credentialRef: data.credentialRef,
            generation: data.generation,
          },
        });
        return updated.count === 1 ? "saved" : "stale_generation";
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const current = await this.get(input.workspaceId);
      if (!current) throw new WorkspaceMemoryScopeError();
      if (
        current.generation === decoded.generation &&
        current.accountId === decoded.accountId &&
        current.credentialRef === decoded.credentialRef
      ) {
        return "saved";
      }
      return "stale_generation";
    }
  }
}
