/**
 * P4 port extension: production MemoryRuntimeProvisioner adapter.
 * Wraps the frozen OpenViking provisioner port; does not edit P1 reconciler.
 */
import {
  mapMemoryActor,
  type CoforgeMemoryActor,
  type OpenVikingBinding,
} from "../openviking/contract";
import type { OpenVikingBindingStore, OpenVikingProvisioner } from "../openviking/stores";
import type {
  MemoryRuntimeHealth,
  MemoryRuntimeKind,
  MemoryRuntimeProvisioner,
  MemoryRuntimeReceipt,
} from "./reconciler";

export type WorkspaceIdentityDirectory = {
  listActors(workspaceId: string): Promise<readonly CoforgeMemoryActor[]>;
};

export type MappedIdentityWriter = {
  replaceWorkspaceIdentities(input: {
    workspaceId: string;
    generation: number;
    identities: readonly {
      actorKind: CoforgeMemoryActor["kind"];
      actorSubject: string;
      mappedUserId: string;
      role: string;
      access: string;
    }[];
  }): Promise<void>;
};

export type MemoryRuntimeReadiness = {
  ensureNamespace(input: {
    workspaceId: string;
    generation: number;
    kind: MemoryRuntimeKind;
    binding: OpenVikingBinding | null;
  }): Promise<void>;
  inspect(input: {
    workspaceId: string;
    generation: number;
    binding: OpenVikingBinding | null;
  }): Promise<MemoryRuntimeHealth>;
};

export function createProductionMemoryRuntimeProvisioner(deps: {
  openviking: OpenVikingProvisioner;
  bindings: OpenVikingBindingStore;
  identities: WorkspaceIdentityDirectory;
  readiness: MemoryRuntimeReadiness;
  mappedIdentities?: MappedIdentityWriter;
}): MemoryRuntimeProvisioner {
  return {
    async ensure({ workspaceId, generation, kind }) {
      void kind;
      return ensureOpenViking(deps, workspaceId, generation);
    },
    async inspectHealth({ workspaceId, generation }) {
      try {
        return await deps.readiness.inspect({
          workspaceId,
          generation,
          binding: await deps.bindings.get(workspaceId),
        });
      } catch {
        return "degraded";
      }
    },
  };
}

export function createPrototypeMemoryRuntimeReadiness(): MemoryRuntimeReadiness {
  return {
    async ensureNamespace() {},
    async inspect() {
      return "healthy";
    },
  };
}

export function createInMemoryWorkspaceIdentityDirectory(
  actors: readonly CoforgeMemoryActor[] = [],
): WorkspaceIdentityDirectory & { setActors(next: readonly CoforgeMemoryActor[]): void } {
  let current = [...actors];
  return {
    setActors(next) {
      current = [...next];
    },
    async listActors() {
      return current;
    },
  };
}

export function createInMemoryMappedIdentityWriter(): MappedIdentityWriter & {
  snapshot(workspaceId: string): readonly {
    actorKind: CoforgeMemoryActor["kind"];
    actorSubject: string;
    mappedUserId: string;
  }[];
} {
  const records = new Map<
    string,
    {
      actorKind: CoforgeMemoryActor["kind"];
      actorSubject: string;
      mappedUserId: string;
      role: string;
      access: string;
    }[]
  >();
  return {
    async replaceWorkspaceIdentities(input) {
      records.set(input.workspaceId, [...input.identities]);
    },
    snapshot(workspaceId) {
      return records.get(workspaceId) ?? [];
    },
  };
}

async function ensureOpenViking(
  deps: {
    openviking: OpenVikingProvisioner;
    bindings: OpenVikingBindingStore;
    identities: WorkspaceIdentityDirectory;
    readiness: MemoryRuntimeReadiness;
    mappedIdentities?: MappedIdentityWriter;
  },
  workspaceId: string,
  generation: number,
): Promise<MemoryRuntimeReceipt> {
  const existing = await deps.bindings.get(workspaceId);
  const binding =
    existing && existing.generation === generation
      ? existing
      : await deps.openviking.provisionBinding({ workspaceId, generation });
  if (binding.workspaceId !== workspaceId || binding.generation !== generation) {
    return {
      workspaceId: binding.workspaceId,
      generation: binding.generation,
      kind: "openviking",
      resourceId: binding.accountId,
    };
  }
  const saved = await deps.bindings.compareAndSet({
    workspaceId,
    expectedGeneration: existing?.generation ?? 0,
    binding,
  });
  const persisted =
    saved === "saved" ? binding : ((await deps.bindings.get(workspaceId)) ?? binding);
  const actors = [
    ...(await deps.identities.listActors(workspaceId)),
    { kind: "projection_worker" as const },
  ];
  await deps.openviking.ensureMappedIdentities({
    workspaceId,
    accountId: persisted.accountId,
    actors,
    generation,
  });
  if (deps.mappedIdentities) {
    await deps.mappedIdentities.replaceWorkspaceIdentities({
      workspaceId,
      generation,
      identities: actors.map((actor) => {
        const mapped = mapMemoryActor({ actor, binding: persisted });
        return {
          actorKind: actor.kind,
          actorSubject: actorSubject(actor),
          mappedUserId: mapped.userId,
          role: mapped.role,
          access: mapped.access,
        };
      }),
    });
  }
  await deps.readiness.ensureNamespace({
    workspaceId,
    generation,
    kind: "openviking",
    binding: persisted,
  });
  return {
    workspaceId,
    generation,
    kind: "openviking",
    resourceId: persisted.accountId,
  };
}

function actorSubject(actor: CoforgeMemoryActor): string {
  switch (actor.kind) {
    case "owner":
    case "admin":
    case "member":
      return actor.userId;
    case "agent":
    case "memory_agent":
      return actor.agentId;
    case "projection_worker":
      return "projection";
  }
}
