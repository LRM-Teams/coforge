import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";
import { ConversationHistory } from "../src/server/conversations/conversation-history.server";

const membership = { id: "workspace-member-1" };

describe("ConversationHistory", () => {
  test("indexes only the current User's messages in the requested direct conversation", async () => {
    const messageQueries: object[] = [];
    const db = {
      workspaceMembership: { findUnique: async () => membership },
      conversation: {
        findFirst: async () => ({
          directKey: "agent:agent-1|user:user-1",
          channelName: null,
          members: [{ id: "conversation-member-1" }],
        }),
      },
      message: {
        findMany: async (input: object) => {
          messageQueries.push(input);
          return [
            {
              id: "message-9",
              sequence: 9,
              body: "Newest prompt",
              createdAt: new Date(9),
              attachment: null,
            },
            {
              id: "message-7",
              sequence: 7,
              body: "Older prompt",
              createdAt: new Date(7),
              attachment: { fileName: "brief.pdf" },
            },
            {
              id: "message-5",
              sequence: 5,
              body: "Previous page",
              createdAt: new Date(5),
              attachment: null,
            },
          ];
        },
      },
    } as unknown as PrismaClient;

    const page = await new ConversationHistory(db).listOwnMessages(
      "workspace-1",
      "user-1",
      "direct-conversation-1",
      { beforeSequence: 12, limit: 2 },
    );

    expect(messageQueries[0]).toMatchObject({
      where: {
        conversationId: "direct-conversation-1",
        threadRootId: null,
        sequence: { lt: 12 },
        sender: { userId: "user-1" },
      },
      orderBy: { sequence: "desc" },
      take: 3,
    });
    expect(page).toEqual({
      hasOlder: true,
      messages: [
        {
          id: "message-7",
          sequence: 7,
          body: "Older prompt",
          createdAt: new Date(7),
          attachmentFileName: "brief.pdf",
        },
        {
          id: "message-9",
          sequence: 9,
          body: "Newest prompt",
          createdAt: new Date(9),
          attachmentFileName: undefined,
        },
      ],
    });
  });

  test("allows a Workspace member to index a public channel without joining it", async () => {
    const conversationQueries: object[] = [];
    const messageQueries: object[] = [];
    const db = {
      workspaceMembership: { findUnique: async () => membership },
      conversation: {
        findFirst: async (input: object) => {
          conversationQueries.push(input);
          return { directKey: null, channelName: "general", members: [] };
        },
      },
      message: {
        findMany: async (input: object) => {
          messageQueries.push(input);
          return [];
        },
      },
    } as unknown as PrismaClient;

    await new ConversationHistory(db).listOwnMessages(
      "workspace-1",
      "user-1",
      "channel-conversation-1",
    );

    expect(conversationQueries[0]).toMatchObject({
      where: { id: "channel-conversation-1", workspaceId: "workspace-1" },
      select: {
        directKey: true,
        channelName: true,
        members: { where: { userId: "user-1" }, select: { id: true } },
      },
    });
    expect(messageQueries[0]).toMatchObject({
      where: {
        conversationId: "channel-conversation-1",
        sender: { userId: "user-1" },
      },
    });
  });

  test("rejects a direct conversation that does not contain the current User", async () => {
    const db = {
      workspaceMembership: { findUnique: async () => membership },
      conversation: {
        findFirst: async () => ({
          directKey: "agent:agent-2|user:user-2",
          channelName: null,
          members: [],
        }),
      },
    } as unknown as PrismaClient;

    await expect(
      new ConversationHistory(db).listOwnMessages(
        "workspace-1",
        "user-1",
        "other-direct-conversation",
      ),
    ).rejects.toThrow("ACCESS_DENIED");
  });

  test("loads an around window only for an own message in the requested conversation", async () => {
    const messageQueries: object[] = [];
    const message = (id: string, sequence: number) => ({
      id,
      sequence,
      threadRootId: null,
      senderMemberId: "user-member-1",
      body: id,
      createdAt: new Date(sequence),
      attachment: null,
      sender:
        sequence === 11
          ? { userId: null, user: null, agent: { name: "builder", displayName: "Build Assistant" } }
          : { userId: "user-1", user: { username: "alice" }, agent: null },
      replies: [],
    });
    const db = {
      workspaceMembership: { findUnique: async () => membership },
      conversation: {
        findFirst: async () => ({
          directKey: null,
          channelName: "engineering",
          members: [],
        }),
      },
      message: {
        findFirst: async (input: object) => {
          messageQueries.push(input);
          return { sequence: 10 };
        },
        findMany: async (input: { orderBy: { sequence: string } }) => {
          messageQueries.push(input);
          return input.orderBy.sequence === "desc"
            ? [message("message-10", 10), message("message-9", 9), message("message-7", 7)]
            : [message("message-11", 11), message("message-13", 13)];
        },
      },
    } as unknown as PrismaClient;

    const page = await new ConversationHistory(db).loadAround(
      "workspace-1",
      "user-1",
      "channel-conversation-1",
      "message-10",
      3,
    );

    expect(messageQueries[0]).toMatchObject({
      where: {
        id: "message-10",
        conversationId: "channel-conversation-1",
        threadRootId: null,
        sender: { userId: "user-1" },
      },
    });
    expect(page).toMatchObject({
      conversationId: "channel-conversation-1",
      hasOlder: true,
      hasNewer: true,
    });
    expect(
      page.messages.map(({ id, sequence, senderMemberId }) => [id, sequence, senderMemberId]),
    ).toEqual([
      ["message-9", 9, "user-member-1"],
      ["message-10", 10, "user-member-1"],
      ["message-11", 11, "user-member-1"],
    ]);
    expect(page.messages.map(({ senderName }) => senderName)).toEqual([
      "@alice",
      "@alice",
      "@builder",
    ]);
  });
});
