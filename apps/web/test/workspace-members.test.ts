import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { WorkspaceMembers } from "#src/server/workspaces/members.server";

describe("WorkspaceMembers", () => {
  test("denies a User who is not a member before reading the directory", async () => {
    let directoryRead = false;
    const db = {
      workspaceMembership: { findUnique: async () => null },
      user: { findMany: async () => ((directoryRead = true), []) },
      agent: { findMany: async () => ((directoryRead = true), []) },
    } as unknown as PrismaClient;

    await expect(
      new WorkspaceMembers(db).agentPage("workspace-1", "outsider", {
        owner: "all",
        query: "",
        limit: 24,
      }),
    ).rejects.toEqual(new AppError("ACCESS_DENIED"));
    expect(directoryRead).toBe(false);
  });

  test("returns all humans and Agents in the Workspace with only public directory fields", async () => {
    const queries: { membership?: object; people?: object; agents?: object } = {};
    const db = {
      workspaceMembership: {
        findUnique: async (query: object) => {
          queries.membership = query;
          return { userId: "viewer", role: "admin" };
        },
      },
      // The order of the page, which the database settles: the ids in the order to show.
      $queryRaw: async () => [{ id: "other-user" }],
      user: {
        findMany: async (query: object) => {
          queries.people = query;
          return [
            {
              id: "other-user",
              username: "grace",
              displayName: null,
              fullName: "Grace Hopper",
              description: "Compiler pioneer",
              email: "private@example.test",
              avatarObjectKey: "avatars/other-user/7f3a/avatar",
              agents: [],
            },
          ];
        },
      },
      agent: {
        findMany: async (query: object) => {
          queries.agents = query;
          return [
            {
              id: "other-agent",
              name: "builder",
              displayName: "",
              description: "Builds releases",
              avatarObjectKey: "workspaces/workspace-1/agents/other-agent/avatars/pic-1/original",
              ownerId: "another-user",
              createdAt: new Date("2026-07-23T08:00:00.000Z"),
              owner: {
                id: "another-user",
                username: "ada",
                displayName: "  Ada Lovelace  ",
                avatarObjectKey: "avatars/another-user/9c1d/avatar",
              },
              runtimeConfig: { apiKey: "private" },
              computer: {
                id: "office-mac-id",
                name: "office-mac",
                displayName: "  Team workstation  ",
                workspaces: [{ id: "workspace-computer" }],
              },
            },
            {
              id: "detached-agent",
              name: "reviewer",
              displayName: "Reviewer",
              description: "Reviews changes",
              ownerId: "another-user",
              createdAt: new Date("2026-08-01T00:00:00.000Z"),
              owner: {
                id: "another-user",
                username: "ada",
                displayName: null,
                avatarObjectKey: null,
              },
              weeklyReportAssistant: { id: "assistant-1" },
              computer: { id: "other-machine-id", name: "other-workspace-machine", workspaces: [] },
            },
          ];
        },
      },
    } as unknown as PrismaClient;

    const members = new WorkspaceMembers(db);
    const [people, agents] = await Promise.all([
      members.peoplePage("workspace-1", "viewer", { query: "", limit: 24 }),
      members.agentPage("workspace-1", "viewer", { owner: "all", query: "", limit: 24 }),
    ]);
    const result = { people: people.items, agents: agents.items };

    expect(queries.membership).toEqual({
      where: { workspaceId_userId: { workspaceId: "workspace-1", userId: "viewer" } },
      select: { userId: true, role: true },
    });
    expect(queries.people).toMatchObject({
      where: { id: { in: ["other-user"] } },
      select: {
        id: true,
        username: true,
        displayName: true,
        description: true,
        avatarObjectKey: true,
      },
    });
    expect(queries.agents).toMatchObject({
      where: { AND: [{ workspaceId: "workspace-1", deletedAt: null }, {}, {}] },
      select: {
        id: true,
        name: true,
        displayName: true,
        description: true,
        avatarObjectKey: true,
        createdAt: true,
        owner: { select: { id: true, username: true, displayName: true, avatarObjectKey: true } },
        weeklyReportAssistant: { select: { id: true } },
        computer: {
          select: {
            id: true,
            name: true,
            displayName: true,
            workspaces: {
              where: { workspaceId: "workspace-1" },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    expect(result).toEqual({
      people: [
        {
          id: "other-user",
          displayName: "Grace Hopper",
          description: "Compiler pioneer",
          avatarUrl: "/api/workspaces/workspace-1/users/other-user/avatar?v=7f3a",
          createdAgents: { total: 0, items: [] },
        },
      ],
      agents: [
        {
          id: "other-agent",
          name: "builder",
          displayName: "builder",
          description: "Builds releases",
          avatarUrl: "/api/workspaces/workspace-1/agents/other-agent/avatar?v=pic-1",
          computerId: "office-mac-id",
          computerName: "Team workstation",
          createdAt: new Date("2026-07-23T08:00:00.000Z"),
          owner: {
            id: "another-user",
            displayName: "Ada Lovelace",
            avatarUrl: "/api/workspaces/workspace-1/users/another-user/avatar?v=9c1d",
          },
          deletable: true,
        },
        {
          id: "detached-agent",
          name: "reviewer",
          displayName: "Reviewer",
          description: "Reviews changes",
          avatarUrl: null,
          computerId: null,
          computerName: null,
          createdAt: new Date("2026-08-01T00:00:00.000Z"),
          owner: { id: "another-user", displayName: "ada", avatarUrl: null },
          deletable: false,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("ownerId");
    expect(JSON.stringify(result)).not.toContain("avatarObjectKey");
  });

  test("hides a private Agent owned by someone else from a plain member's directory", async () => {
    let agentQuery: object | undefined;
    const db = {
      workspaceMembership: {
        findUnique: async () => ({ userId: "viewer", role: "member" }),
      },
      user: { findMany: async () => [] },
      agent: {
        findMany: async (query: object) => {
          agentQuery = query;
          return [];
        },
      },
    } as unknown as PrismaClient;

    await new WorkspaceMembers(db).agentPage("workspace-1", "viewer", {
      owner: "all",
      query: "",
      limit: 24,
    });

    const [visible] = (agentQuery as { where: { AND: object[] } }).where.AND;
    expect(visible).toEqual({
      workspaceId: "workspace-1",
      deletedAt: null,
      OR: [{ visibility: "public" }, { ownerId: "viewer" }],
    });
  });

  test("an owner/admin's directory query has nothing to hide", async () => {
    let agentQuery: object | undefined;
    const db = {
      workspaceMembership: {
        findUnique: async () => ({ userId: "viewer", role: "admin" }),
      },
      user: { findMany: async () => [] },
      agent: {
        findMany: async (query: object) => {
          agentQuery = query;
          return [];
        },
      },
    } as unknown as PrismaClient;

    await new WorkspaceMembers(db).agentPage("workspace-1", "viewer", {
      owner: "all",
      query: "",
      limit: 24,
    });

    const [visible] = (agentQuery as { where: { AND: object[] } }).where.AND;
    expect(visible).toEqual({ workspaceId: "workspace-1", deletedAt: null });
  });
  describe("directory", () => {
    const directoryOf = (people: object[]) =>
      new WorkspaceMembers({
        workspaceMembership: { findUnique: async () => ({ userId: "viewer", role: "member" }) },
        user: { findMany: async () => people },
        agent: {
          findMany: async () => [
            {
              id: "agent-1",
              name: "atlas",
              displayName: "Atlas Bot",
              avatarObjectKey: null,
              ownerId: "viewer",
            },
          ],
        },
        conversationMember: { findMany: async () => [] },
      } as unknown as PrismaClient).directory("workspace-1", "viewer");

    test("a person carries the names they are shown by and no username", async () => {
      const { people } = await directoryOf([
        {
          id: "user-1",
          username: "grace-hopper-4k2",
          displayName: "Amazing Grace",
          fullName: "Grace Hopper",
          avatarObjectKey: null,
        },
        {
          id: "user-2",
          username: "ada-9d3",
          displayName: null,
          fullName: null,
          avatarObjectKey: null,
        },
      ]);
      // Listed by the name shown, so the person with no names sorts by their username label.
      expect(people).toEqual([
        { id: "user-2", name: "ada-9d3", fullName: null, avatarUrl: null, dmId: null },
        {
          id: "user-1",
          name: "Amazing Grace",
          fullName: "Grace Hopper",
          avatarUrl: null,
          dmId: null,
        },
      ]);
      expect(JSON.stringify(people)).not.toContain("grace-hopper-4k2");
    });

    test("an Agent keeps its @handle", async () => {
      const { agents } = await directoryOf([]);
      expect(agents).toMatchObject([{ id: "agent-1", handle: "atlas", name: "Atlas Bot" }]);
    });
  });
});
