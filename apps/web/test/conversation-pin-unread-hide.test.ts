import { expect, test } from "bun:test";
import type { PrismaClient } from "@/generated/prisma/client";
import { isAppError } from "@/lib/app-error";
import { PublicChannels } from "@/server/conversations/public-channels.server";

/**
 * P2b (#125) of the saved/pinned plan: pin/unpin with its order, the forced-unread marker, and the
 * per-member hide/close — all three are member-level facts that only the conversation list and the
 * member's own row observe, so the fixture is deliberately the smallest database that can answer
 * `channel()` (the access check every mutation starts with) and `list()`.
 */
const WORKSPACE_ID = "workspace-1";
const USER_ID = "user-1";
const CHANNEL_ID = "channel-1";

type MemberState = {
  unreadFromSequence: number | null;
  hiddenAt: Date | null;
  readThroughSequence: number;
};

function fixture(options: { member?: boolean; newestSequence?: number } = {}) {
  const member: MemberState = {
    unreadFromSequence: null,
    hiddenAt: null,
    readThroughSequence: 0,
  };
  const pins: {
    conversationId: string;
    memberId: string;
    workspaceId: string;
    sortOrder: number;
  }[] = [];
  const memberId = "member-1";
  const writes: Record<string, unknown>[] = [];
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "member" }) },
    conversation: {
      // `channel()`: the access check each mutation begins with.
      findFirst: async () => ({ id: CHANNEL_ID, channelName: "ops", archivedAt: null }),
      findMany: async () => [
        {
          id: CHANNEL_ID,
          channelName: "ops",
          archivedAt: null,
          members:
            options.member === false
              ? []
              : [
                  {
                    id: memberId,
                    channelMuted: false,
                    readThroughSequence: member.readThroughSequence,
                    unreadFromSequence: member.unreadFromSequence,
                    hiddenAt: member.hiddenAt,
                    pins: pins.map((pin) => ({ sortOrder: pin.sortOrder })),
                  },
                ],
        },
      ],
    },
    conversationMember: {
      findFirst: async () => (options.member === false ? null : { id: memberId }),
      updateMany: async ({ data }: { data: Partial<MemberState> }) => {
        if (options.member === false) return { count: 0 };
        writes.push(data);
        Object.assign(member, data);
        return { count: 1 };
      },
    },
    conversationPin: {
      count: async ({ where }: { where: { memberId: string } }) =>
        pins.filter((pin) => pin.memberId === where.memberId).length,
      deleteMany: async ({ where }: { where: { memberId: string } }) => {
        const before = pins.length;
        for (let index = pins.length - 1; index >= 0; index -= 1)
          if (pins[index]!.memberId === where.memberId) pins.splice(index, 1);
        return { count: before - pins.length };
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
    message: {
      findFirst: async () =>
        options.newestSequence === undefined ? null : { sequence: options.newestSequence },
    },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
    $queryRaw: async () => [
      {
        conversationId: CHANNEL_ID,
        unread:
          member.unreadFromSequence !== null && options.newestSequence !== undefined
            ? Math.max(1, (options.newestSequence ?? 0) - member.unreadFromSequence + 1)
            : 0,
      },
    ],
  } as unknown as PrismaClient;
  return { channels: new PublicChannels(db), member, pins, writes };
}

test("pinning adds the row with the next free order, and re-pinning moves it rather than duplicating", async () => {
  const { channels, pins } = fixture();
  await channels.setUserPinned(WORKSPACE_ID, USER_ID, CHANNEL_ID, true);
  expect(pins).toEqual([
    {
      conversationId: CHANNEL_ID,
      memberId: "member-1",
      workspaceId: WORKSPACE_ID,
      sortOrder: 0,
    },
  ]);

  // An explicit order moves the existing pin; the member never ends up with two rows for one chat.
  await channels.setUserPinned(WORKSPACE_ID, USER_ID, CHANNEL_ID, true, 7);
  expect(pins).toHaveLength(1);
  expect(pins[0]!.sortOrder).toBe(7);

  await channels.setUserPinned(WORKSPACE_ID, USER_ID, CHANNEL_ID, false);
  expect(pins).toEqual([]);
});

test("a non-member cannot pin, mark unread, or hide", async () => {
  for (const call of [
    (channels: PublicChannels) => channels.setUserPinned(WORKSPACE_ID, USER_ID, CHANNEL_ID, true),
    (channels: PublicChannels) => channels.setUserUnread(WORKSPACE_ID, USER_ID, CHANNEL_ID, true),
    (channels: PublicChannels) => channels.setUserHidden(WORKSPACE_ID, USER_ID, CHANNEL_ID, true),
  ]) {
    const { channels } = fixture({ member: false });
    const error = await call(channels).catch((cause: unknown) => cause);
    expect(isAppError(error)).toBe(true);
    expect(isAppError(error) && error.code).toBe("ACCESS_DENIED");
  }
});

test("marking unread anchors on the newest top-level message, and clearing sets it back", async () => {
  const { channels, member } = fixture({ newestSequence: 12 });
  await channels.setUserUnread(WORKSPACE_ID, USER_ID, CHANNEL_ID, true);
  expect(member.unreadFromSequence).toBe(12);

  await channels.setUserUnread(WORKSPACE_ID, USER_ID, CHANNEL_ID, false);
  expect(member.unreadFromSequence).toBeNull();
});

test("a conversation with no messages has nothing to mark unread", async () => {
  const { channels, member } = fixture();
  const result = await channels.setUserUnread(WORKSPACE_ID, USER_ID, CHANNEL_ID, true);
  expect(member.unreadFromSequence).toBeNull();
  expect(result).toEqual({ unread: false });
});

test("reading past the forced marker consumes it", async () => {
  const { channels, member } = fixture({ newestSequence: 12 });
  await channels.setUserUnread(WORKSPACE_ID, USER_ID, CHANNEL_ID, true);
  await channels.markRead(WORKSPACE_ID, USER_ID, CHANNEL_ID, 12);
  expect(member.unreadFromSequence).toBeNull();
  expect(member.readThroughSequence).toBe(12);
});

test("hiding stamps the member's own row and closing again clears it", async () => {
  const { channels, member } = fixture();
  await channels.setUserHidden(WORKSPACE_ID, USER_ID, CHANNEL_ID, true);
  expect(member.hiddenAt).toBeInstanceOf(Date);

  await channels.setUserHidden(WORKSPACE_ID, USER_ID, CHANNEL_ID, false);
  expect(member.hiddenAt).toBeNull();
});

test("the list hides a closed chat, reports pins, and puts them first", async () => {
  const { channels } = fixture();
  await channels.setUserPinned(WORKSPACE_ID, USER_ID, CHANNEL_ID, true);
  const listed = await channels.list(WORKSPACE_ID, USER_ID);
  expect(listed).toEqual([
    expect.objectContaining({
      id: CHANNEL_ID,
      joined: true,
      hidden: false,
      pinned: true,
      pinSortOrder: 0,
    }),
  ]);

  await channels.setUserHidden(WORKSPACE_ID, USER_ID, CHANNEL_ID, true);
  expect(await channels.list(WORKSPACE_ID, USER_ID)).toEqual([]);
});
