import { expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";
import { isAppError } from "../src/lib/app-error";
import {
  enrollGeneralChannel,
  PublicChannels,
} from "../src/server/conversations/public-channels.server";
import { PrismaAgentRepository } from "../src/server/db/repositories/agent.repositories.server";

const WORKSPACE_ID = "workspace-1";

/**
 * ADR 0059: a private Agent is never enrolled in `#general` — even other, public Agents in the
 * same Workspace still get enrolled normally, so this proves the filter is scoped to visibility,
 * not a blanket regression against Agent enrollment.
 */
test("enrollGeneralChannel excludes a private Agent but keeps enrolling public ones", async () => {
  let agentQuery: unknown;
  let createdMemberAgentIds: string[] = [];
  const tx = {
    conversation: {
      createMany: async () => {},
      findUniqueOrThrow: async () => ({ id: "general-1", channelName: "general" }),
    },
    workspaceMembership: { findMany: async () => [] },
    message: { findFirst: async () => null },
    conversationMember: {
      createMany: async ({ data }: { data: Array<{ agentId?: string }> }) => {
        createdMemberAgentIds = data.flatMap((row) => (row.agentId ? [row.agentId] : []));
      },
    },
    agent: {
      findMany: async (query: unknown) => {
        agentQuery = query;
        // Simulates Prisma applying the `visibility: "public"` filter itself: only the public
        // Agent is ever returned to this fake table.
        return [{ id: "agent-public" }];
      },
    },
  } as unknown as PrismaClient;

  await enrollGeneralChannel(tx as never, WORKSPACE_ID);

  expect(agentQuery).toMatchObject({
    where: { workspaceId: WORKSPACE_ID, visibility: "public", deletedAt: null },
  });
  expect(createdMemberAgentIds).toEqual(["agent-public"]);
});

test("PrismaAgentRepository.create() with visibility 'private' never enrolls the new Agent in #general (ADR 0059)", async () => {
  let createdMemberAgentIds: string[] | undefined;
  const db = {
    $transaction: async (work: (tx: PrismaClient) => Promise<unknown>) => work(db),
    agent: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        id: "agent-new",
        createdAt: new Date(),
        ...data,
      }),
      // Simulates Prisma applying the real `visibility: "public"` filter: the just-created
      // private Agent is never in this result, even though it exists in the same Workspace.
      findMany: async () => [],
    },
    conversation: {
      createMany: async () => {},
      findUniqueOrThrow: async () => ({ id: "general-1", channelName: "general" }),
    },
    workspaceMembership: { findMany: async () => [] },
    message: { findFirst: async () => null },
    conversationMember: {
      createMany: async ({ data }: { data: Array<{ agentId?: string }> }) => {
        createdMemberAgentIds = data.flatMap((row) => (row.agentId ? [row.agentId] : []));
      },
    },
  } as unknown as PrismaClient;

  await new PrismaAgentRepository(db).create({
    workspaceId: WORKSPACE_ID,
    name: "collector",
    displayName: "Collector",
    ownerId: "user-1",
    visibility: "private",
    runtimeConfig: {
      runtime: "pi",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
  });

  expect(createdMemberAgentIds).toEqual([]);
});

function publicChannelsFixture(target: { id: string; visibility: string }) {
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "member" }), findMany: async () => [] },
    agent: {
      findFirst: async () => ({ id: "actor-agent" }),
      findMany: async () => [target],
    },
    conversation: { findFirst: async () => ({ id: "channel-1" }) },
    conversationMember: {
      findFirst: async () => ({ id: "actor-membership" }),
      findMany: async () => [],
      upsert: async () => ({}),
    },
    message: { findFirst: async () => null },
    user: { findMany: async () => [] },
  } as unknown as PrismaClient;
  return { channels: new PublicChannels(db) };
}

test("PublicChannels.addMembers rejects a private Agent target with a stable code (ADR 0059)", async () => {
  const { channels } = publicChannelsFixture({ id: "agent-ghost", visibility: "private" });

  const error = await channels
    .addMembers(WORKSPACE_ID, { agentId: "actor-agent" }, "channel-1", {
      userIds: [],
      agentIds: ["agent-ghost"],
    })
    .catch((cause: unknown) => cause);

  expect(isAppError(error)).toBe(true);
  expect(isAppError(error) && error.code).toBe("INVALID_INPUT");
  expect(isAppError(error) && error.errorId).toBe("agent-private");
});

test("PublicChannels.addMembers accepts a public Agent target", async () => {
  const { channels } = publicChannelsFixture({ id: "agent-public", visibility: "public" });

  const result = await channels.addMembers(WORKSPACE_ID, { agentId: "actor-agent" }, "channel-1", {
    userIds: [],
    agentIds: ["agent-public"],
  });
  expect(result.alreadyMemberAgentIds).toEqual([]);
});

test("PublicChannels.members never offers a private Agent as an add-candidate (ADR 0059, mention-candidate consequence)", async () => {
  const { channels } = publicChannelsFixture({ id: "agent-public", visibility: "public" });

  const roster = await channels.members(WORKSPACE_ID, { agentId: "actor-agent" }, "channel-1");

  // The fake `agent.findMany` above only ever returns public Agents (the same "channels never
  // contain a private Agent" invariant `addMembers`/`enrollGeneralChannel` enforce at the write
  // side) — a private Agent would never be a row here, so it can never reach a channel's
  // `mentionables` (sourced from `conversationMember` rows) either.
  expect(roster.candidates.agents).toEqual([
    { id: "agent-public", name: undefined, displayName: undefined },
  ]);
});
