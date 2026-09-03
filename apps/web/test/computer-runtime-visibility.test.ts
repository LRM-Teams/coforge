import { describe, expect, test } from "bun:test";
import {
  ComputerRuntimeVisibility,
  type ComputerRuntimeRecord,
  type ComputerRuntimeVisibilityRepository,
} from "../src/server/computers/computer-runtime-visibility.server";

function fixture() {
  const records: ComputerRuntimeRecord[] = [
    {
      id: "owned-private",
      computerId: "computer-1",
      ownerId: "user-1",
      provider: "codex",
      version: "1",
      displayName: "Codex",
      observedAt: new Date("2026-09-03T00:00:00Z"),
      isPublic: false,
    },
    {
      id: "shared-public",
      computerId: "computer-2",
      ownerId: "user-2",
      provider: "claude-code",
      version: "2",
      displayName: "Claude Code",
      observedAt: new Date("2026-09-03T00:00:00Z"),
      isPublic: true,
    },
    {
      id: "other-private",
      computerId: "computer-2",
      ownerId: "user-2",
      provider: "codex",
      version: "1",
      displayName: "Codex",
      observedAt: new Date("2026-09-03T00:00:00Z"),
      isPublic: false,
    },
  ];
  const repository: ComputerRuntimeVisibilityRepository = {
    listInWorkspace: async () => records,
    findInWorkspace: async (_workspaceId, computerId, provider) =>
      records.find((record) => record.computerId === computerId && record.provider === provider),
    findByIdInWorkspace: async (_workspaceId, runtimeId) =>
      records.find((record) => record.id === runtimeId),
    setPublic: async (runtimeId, isPublic) => {
      const record = records.find((candidate) => candidate.id === runtimeId);
      if (!record) throw new Error("runtime is not available");
      record.isPublic = isPublic;
    },
  };
  return { records, visibility: new ComputerRuntimeVisibility(repository) };
}

describe("ComputerRuntimeVisibility", () => {
  test("shows private runtimes only to their Computer owner", async () => {
    const { visibility } = fixture();

    expect(
      (await visibility.list({ userId: "user-1", workspaceId: "workspace-1" })).map(({ id }) => id),
    ).toEqual(["owned-private", "shared-public"]);
    expect(
      (await visibility.list({ userId: "user-3", workspaceId: "workspace-1" })).map(({ id }) => id),
    ).toEqual(["shared-public"]);
  });

  test("allows selection by the owner or after publication", async () => {
    const { visibility } = fixture();
    const owner = { userId: "user-1", workspaceId: "workspace-1" };
    const member = { userId: "user-3", workspaceId: "workspace-1" };

    expect(await visibility.canSelect(owner, "computer-1", "codex")).toBe(true);
    expect(await visibility.canSelect(member, "computer-1", "codex")).toBe(false);
    await visibility.setPublic(owner, "owned-private", true);
    expect(await visibility.canSelect(member, "computer-1", "codex")).toBe(true);
  });

  test("publication does not grant owner-only runtime management", async () => {
    const { visibility } = fixture();

    expect(
      await visibility.isOwner(
        { userId: "user-2", workspaceId: "workspace-1" },
        "computer-2",
        "claude-code",
      ),
    ).toBe(true);
    expect(
      await visibility.isOwner(
        { userId: "user-3", workspaceId: "workspace-1" },
        "computer-2",
        "claude-code",
      ),
    ).toBe(false);
  });

  test("only the Computer owner can change visibility", async () => {
    const { visibility } = fixture();

    await expect(
      visibility.setPublic({ userId: "user-3", workspaceId: "workspace-1" }, "other-private", true),
    ).rejects.toThrow("runtime is not owned by the current user");
  });
});
