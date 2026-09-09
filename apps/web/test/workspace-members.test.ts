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
    const queries: { people?: object; agents?: object } = {};
    const db = {
      workspaceMembership: { findUnique: async () => ({ userId: "viewer" }) },
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
              avatarObjectKey: "private/avatar",
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
              ownerId: "another-user",
              runtimeConfig: { apiKey: "private" },
              computer: {
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
              computer: { name: "other-workspace-machine", workspaces: [] },
            },
          ];
        },
      },
    } as unknown as PrismaClient;

    const result = await new WorkspaceMembers(db).list("workspace-1", "viewer");

    expect(queries.people).toEqual({
      where: { memberships: { some: { workspaceId: "workspace-1" } } },
      select: { id: true, username: true, displayName: true, description: true },
      orderBy: [{ username: "asc" }, { id: "asc" }],
    });
    expect(queries.agents).toEqual({
      where: { workspaceId: "workspace-1" },
      select: {
        id: true,
        name: true,
        displayName: true,
        description: true,
        computer: {
          select: {
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
          name: "grace",
          displayName: "grace",
          description: "Compiler pioneer",
        },
      ],
      agents: [
        {
          id: "other-agent",
          name: "builder",
          displayName: "builder",
          description: "Builds releases",
          computerName: "Team workstation",
        },
        {
          id: "detached-agent",
          name: "reviewer",
          displayName: "Reviewer",
          description: "Reviews changes",
          computerName: null,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("ownerId");
    expect(JSON.stringify(result)).not.toContain("avatarObjectKey");
  });
});
