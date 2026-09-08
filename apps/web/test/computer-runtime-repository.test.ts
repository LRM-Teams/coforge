import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";
import { PrismaComputerRuntimeRepository } from "../src/server/db/repositories/computer-runtime.repositories.server";

describe("PrismaComputerRuntimeRepository", () => {
  test("replaces inventory only inside the trusted Workspace–Computer scope", async () => {
    const calls: Array<{ operation: string; args: unknown }> = [];
    const transaction = {
      workspaceComputer: {
        findUnique: async (args: unknown) => {
          calls.push({ operation: "findConnection", args });
          return { id: "connection-1" };
        },
      },
      computerRuntime: {
        deleteMany: async (args: unknown) => calls.push({ operation: "deleteRuntimes", args }),
        upsert: async (args: unknown) => calls.push({ operation: "upsertRuntime", args }),
      },
      computerModelCatalog: {
        deleteMany: async (args: unknown) => calls.push({ operation: "deleteCatalogs", args }),
        createMany: async (args: unknown) => calls.push({ operation: "createCatalogs", args }),
      },
    };
    const db = {
      $transaction: async (execute: (tx: typeof transaction) => Promise<void>) =>
        execute(transaction),
    } as unknown as PrismaClient;

    await new PrismaComputerRuntimeRepository(db).replace(
      { workspaceId: "workspace-1", computerId: "computer-1" },
      [{ provider: "codex", version: "1", displayName: "Codex" }],
      [{ provider: "codex", models: [] }],
    );

    expect(calls).toContainEqual({
      operation: "deleteCatalogs",
      args: { where: { workspaceId: "workspace-1", computerId: "computer-1" } },
    });
    expect(calls).toContainEqual({
      operation: "upsertRuntime",
      args: {
        where: {
          workspaceId_computerId_provider: {
            workspaceId: "workspace-1",
            computerId: "computer-1",
            provider: "codex",
          },
        },
        create: {
          workspaceId: "workspace-1",
          computerId: "computer-1",
          provider: "codex",
          version: "1",
          displayName: "Codex",
        },
        update: { version: "1", displayName: "Codex", observedAt: expect.any(Date) },
      },
    });
    expect(calls).toContainEqual({
      operation: "createCatalogs",
      args: {
        data: [
          {
            workspaceId: "workspace-1",
            computerId: "computer-1",
            provider: "codex",
            models: [],
          },
        ],
      },
    });
  });
});
