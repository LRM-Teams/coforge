import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";
import { AppError } from "../src/lib/app-error";
import { WorkspaceMembers } from "../src/server/workspaces/members.server";

describe("WorkspaceMembers", () => {
  test("denies a User who is not a member before reading the directory", async () => {
    let directoryRead = false;
    const db = {
      workspaceMembership: { findUnique: async () => null },
      user: { findMany: async () => ((directoryRead = true), []) },
      agent: { findMany: async () => ((directoryRead = true), []) },
    } as unknown as PrismaClient;

    await expect(new WorkspaceMembers(db).list("workspace-1", "outsider")).rejects.toEqual(
      new AppError("ACCESS_DENIED"),
    );
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
      user: {
        findMany: async (query: object) => {
          queries.people = query;
          return [
            {
              id: "other-user",
              username: "grace",
              displayName: null,
              description: "Compiler pioneer",
              email: "private@example.test",
              avatarObjectKey: "avatars/other-user/7f3a/avatar",
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

    const result = await new WorkspaceMembers(db).list("workspace-1", "viewer");

    expect(queries.membership).toEqual({
      where: { workspaceId_userId: { workspaceId: "workspace-1", userId: "viewer" } },
      select: { userId: true, role: true },
    });
    expect(queries.people).toEqual({
      where: { memberships: { some: { workspaceId: "workspace-1" } } },
      select: {
        id: true,
        username: true,
        displayName: true,
        description: true,
        avatarObjectKey: true,
      },
      orderBy: [{ username: "asc" }, { id: "asc" }],
    });
    expect(queries.agents).toEqual({
      where: {
        workspaceId: "workspace-1",
        deletedAt: null,
      },
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
      actorRole: "admin",
      viewerId: "viewer",
      people: [
        {
          id: "other-user",
          name: "grace",
          displayName: "grace",
          description: "Compiler pioneer",
          avatarUrl: "/api/workspaces/workspace-1/users/other-user/avatar?v=7f3a",
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

  test("hides a private Agent owned by someone else from a plain member's directory (ADR 0059)", async () => {
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

    await new WorkspaceMembers(db).list("workspace-1", "viewer");

    expect(agentQuery).toMatchObject({
      where: {
        workspaceId: "workspace-1",
        deletedAt: null,
        OR: [{ visibility: "public" }, { ownerId: "viewer" }],
      },
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

    await new WorkspaceMembers(db).list("workspace-1", "viewer");

    expect(agentQuery).toMatchObject({
      where: { workspaceId: "workspace-1", deletedAt: null },
    });
    expect((agentQuery as { where: object }).where).not.toHaveProperty("OR");
  });
});
