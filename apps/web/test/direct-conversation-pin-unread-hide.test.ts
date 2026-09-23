import { expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";
import { isAppError } from "../src/lib/app-error";
import { PrismaDirectConversationRepository } from "../src/server/db/repositories/direct-conversation.repositories.server";

/**
 * The DM half of P2b (#125). The sidebar's DM rows come from the live Agent list rather than a
 * server list, so what it needs here is preferences keyed by **agentId**; and because a preference
 * must never have the side effect of starting a conversation, every mutation resolves the viewer's
 * DM through a lookup and answers `NOT_FOUND` when there is none.
 */
const WORKSPACE_ID = "workspace-1";
const USER_ID = "user-1";
const AGENT_ID = "agent-1";
const CONVERSATION_ID = "dm-1";

function fixture(options: { exists?: boolean } = {}) {
  const exists = options.exists ?? true;
  const member = {
    id: "member-1",
    unreadFromSequence: null as number | null,
    hiddenAt: null as Date | null,
    readThroughSequence: 0,
  };
  const pins: {
    conversationId: string;
    memberId: string;
    workspaceId: string;
    sortOrder: number;
  }[] = [];
  const created: Record<string, unknown>[] = [];
  const db = {
    // `getOrCreateUserAgent` (used by markReadForUser) resolves the Agent first.
    agent: { findFirst: async () => ({ id: AGENT_ID, ownerId: USER_ID, visibility: "public" }) },
    conversation: {
      // Both `findUserAgentConversation` and `getOrCreateUserAgent` begin here.
      findUnique: async () => (exists ? { id: CONVERSATION_ID } : null),
      findUniqueOrThrow: async () => ({ id: CONVERSATION_ID }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: CONVERSATION_ID };
      },
    },
    conversationMember: {
      findFirst: async () => (exists ? { id: member.id } : null),
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        // `preferencesForUser` asks twice: the existing DMs, and the closed ones.
        where.hiddenAt
          ? exists && member.hiddenAt !== null
            ? [{ conversation: { members: [{ agentId: AGENT_ID }] } }]
            : []
          : exists
            ? [{ conversation: { members: [{ agentId: AGENT_ID }] } }]
            : [],
      updateMany: async ({ data }: { data: Partial<typeof member> }) => {
        Object.assign(member, data);
        return { count: 1 };
      },
    },
    conversationPin: {
      findMany: async () =>
        pins.map((pin) => ({
          sortOrder: pin.sortOrder,
          conversation: { members: [{ agentId: AGENT_ID }] },
        })),
      count: async () => pins.length,
      deleteMany: async ({ where }: { where: { memberId: string } }) => {
        for (let index = pins.length - 1; index >= 0; index -= 1)
          if (pins[index]!.memberId === where.memberId) pins.splice(index, 1);
        return { count: 1 };
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { conversationId_memberId: { memberId: string } };
        create: (typeof pins)[number];
        update: { sortOrder: number };
      }) => {
        const existing = pins.find(
          (pin) => pin.memberId === where.conversationId_memberId.memberId,
        );
        if (existing) existing.sortOrder = update.sortOrder;
        else pins.push(create);
        return create;
      },
    },
    message: { findFirst: async () => ({ sequence: 12 }) },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
    $queryRaw: async () => [],
  } as unknown as PrismaClient;
  return {
    repository: new PrismaDirectConversationRepository(db),
    member,
    pins,
    created,
  };
}

test("a DM that does not exist answers NOT_FOUND and is not created by a preference", async () => {
  const { repository, created } = fixture({ exists: false });
  for (const call of [
    () => repository.setPinnedForUser(WORKSPACE_ID, USER_ID, AGENT_ID, true),
    () => repository.setUnreadForUser(WORKSPACE_ID, USER_ID, AGENT_ID, true),
    () => repository.setHiddenForUser(WORKSPACE_ID, USER_ID, AGENT_ID, true),
  ]) {
    const error = await call().catch((cause: unknown) => cause);
    expect(isAppError(error)).toBe(true);
    expect(isAppError(error) && error.code).toBe("NOT_FOUND");
  }
  expect(created).toEqual([]);
});

test("pinning a DM adds the row with the next free order, and unpinning removes it", async () => {
  const { repository, pins } = fixture();
  await repository.setPinnedForUser(WORKSPACE_ID, USER_ID, AGENT_ID, true);
  expect(pins).toEqual([
    {
      conversationId: CONVERSATION_ID,
      memberId: "member-1",
      workspaceId: WORKSPACE_ID,
      sortOrder: 0,
    },
  ]);

  await repository.setPinnedForUser(WORKSPACE_ID, USER_ID, AGENT_ID, true, 7);
  expect(pins).toHaveLength(1);
  expect(pins[0]!.sortOrder).toBe(7);

  await repository.setPinnedForUser(WORKSPACE_ID, USER_ID, AGENT_ID, false);
  expect(pins).toEqual([]);
});

test("marking a DM unread anchors on its newest top-level message; clearing sets it back", async () => {
  const { repository, member } = fixture();
  await repository.setUnreadForUser(WORKSPACE_ID, USER_ID, AGENT_ID, true);
  expect(member.unreadFromSequence).toBe(12);

  await repository.setUnreadForUser(WORKSPACE_ID, USER_ID, AGENT_ID, false);
  expect(member.unreadFromSequence).toBeNull();
});

test("reading past the forced marker consumes it, on the DM path too", async () => {
  const { repository, member } = fixture();
  await repository.setUnreadForUser(WORKSPACE_ID, USER_ID, AGENT_ID, true);
  await repository.markReadForUser(WORKSPACE_ID, USER_ID, AGENT_ID, 12);
  expect(member.unreadFromSequence).toBeNull();
  expect(member.readThroughSequence).toBe(12);
});

test("closing a DM stamps the viewer's own row, and reopening clears it", async () => {
  const { repository, member } = fixture();
  await repository.setHiddenForUser(WORKSPACE_ID, USER_ID, AGENT_ID, true);
  expect(member.hiddenAt).toBeInstanceOf(Date);

  await repository.setHiddenForUser(WORKSPACE_ID, USER_ID, AGENT_ID, false);
  expect(member.hiddenAt).toBeNull();
});

test("preferences report existing DMs, pins in order, and closed DMs", async () => {
  const { repository } = fixture();
  await repository.setPinnedForUser(WORKSPACE_ID, USER_ID, AGENT_ID, true, 3);
  await repository.setHiddenForUser(WORKSPACE_ID, USER_ID, AGENT_ID, true);

  expect(await repository.preferencesForUser(WORKSPACE_ID, USER_ID)).toEqual({
    conversations: [AGENT_ID],
    pinned: [{ agentId: AGENT_ID, sortOrder: 3 }],
    hidden: [AGENT_ID],
  });

  // Without a conversation the sidebar has nothing to offer: the row is an Agent, not a DM.
  const empty = fixture({ exists: false });
  expect(await empty.repository.preferencesForUser(WORKSPACE_ID, USER_ID)).toEqual({
    conversations: [],
    pinned: [],
    hidden: [],
  });
});
