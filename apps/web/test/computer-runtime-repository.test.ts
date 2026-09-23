import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/generated/prisma/client";
import { PrismaComputerRuntimeRepository } from "@/server/db/repositories/computer-runtime.repositories.server";

function recordingTransaction() {
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
      upsert: async (args: unknown) => calls.push({ operation: "upsertCatalog", args }),
    },
  };
  const db = {
    $transaction: async (execute: (tx: typeof transaction) => Promise<void>) =>
      execute(transaction),
  } as unknown as PrismaClient;
  return { db, calls };
}

describe("PrismaComputerRuntimeRepository", () => {
  test("keeps a failed provider's last-known catalog instead of clearing the whole Computer", async () => {
    const { db, calls } = recordingTransaction();

    await new PrismaComputerRuntimeRepository(db).replace(
      { workspaceId: "workspace-1", computerId: "computer-1" },
      [
        { provider: "codex", version: "1", displayName: "Codex" },
        { provider: "cursor", version: "2", displayName: "Cursor" },
      ],
      [{ provider: "codex", models: [] }],
    );

    // Cursor is still an installed runtime but reported no catalog this round (a probe failure);
    // its last-known row must survive. Only providers that are no longer installed are removed.
    expect(calls).toContainEqual({
      operation: "deleteCatalogs",
      args: {
        where: {
          workspaceId: "workspace-1",
          computerId: "computer-1",
          provider: { notIn: ["codex", "cursor"] },
        },
      },
    });
    expect(calls).toContainEqual({
      operation: "upsertCatalog",
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
          models: [],
        },
        update: { models: [], observedAt: expect.any(Date) },
      },
    });
    expect(calls.some((call) => call.operation === "createCatalogs")).toBe(false);
  });

  test("replaces inventory only inside the trusted Workspace-Computer scope", async () => {
    const { db, calls } = recordingTransaction();

    await new PrismaComputerRuntimeRepository(db).replace(
      { workspaceId: "workspace-1", computerId: "computer-1" },
      [{ provider: "codex", version: "1", displayName: "Codex" }],
      [{ provider: "codex", models: [] }],
    );

    expect(calls).toContainEqual({
      operation: "findConnection",
      args: {
        where: {
          workspaceId_computerId: { workspaceId: "workspace-1", computerId: "computer-1" },
        },
        select: { id: true },
      },
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
  });

  test("drops every catalog once no runtime remains installed", async () => {
    const { db, calls } = recordingTransaction();

    await new PrismaComputerRuntimeRepository(db).replace(
      { workspaceId: "workspace-1", computerId: "computer-1" },
      [],
      [],
    );

    expect(calls).toContainEqual({
      operation: "deleteCatalogs",
      args: { where: { workspaceId: "workspace-1", computerId: "computer-1" } },
    });
  });
});
