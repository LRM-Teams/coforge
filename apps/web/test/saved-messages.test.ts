import { describe, expect, test } from "bun:test";

import {
  savedMessageView,
  type SavedMessageRow,
} from "#src/server/conversations/saved-messages.server";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

/** One full row as `savedMessageSelect` returns it; sender details vary per case. */
function row(overrides: {
  message?: Partial<SavedMessageRow["message"]>;
  savedAt?: Date;
  conversation?: SavedMessageRow["conversation"];
}): SavedMessageRow {
  return {
    createdAt: overrides.savedAt ?? new Date("2026-09-23T02:00:00Z"),
    conversation: overrides.conversation ?? {
      id: "22222222-2222-4222-8222-222222222222",
      channelName: "coforge",
      directKey: null,
    },
    message: {
      id: "33333333-3333-4333-8333-333333333333",
      sequence: 7,
      threadRootId: null,
      senderMemberId: "44444444-4444-4444-8444-444444444444",
      body: "hello **world**",
      createdAt: new Date("2026-09-23T01:00:00Z"),
      attachments: [],
      sender: {
        userId: "55555555-5555-4555-8555-555555555555",
        agentId: null,
        user: { username: "frank", displayName: "Frank", avatarObjectKey: null },
        agent: null,
      },
      mentions: [],
      reactions: [],
      ...overrides.message,
    },
  };
}

describe("savedMessageView", () => {
  test("carries savedAt and conversation context beside the browser message", () => {
    const savedAt = new Date("2026-09-23T02:34:56Z");
    const view = savedMessageView(row({ savedAt }), WORKSPACE_ID);
    expect(view.savedAt).toEqual(savedAt);
    expect(view.conversation).toEqual({
      id: "22222222-2222-4222-8222-222222222222",
      channelName: "coforge",
      directKey: null,
    });
    expect(view.message.id).toBe("33333333-3333-4333-8333-333333333333");
    expect(view.message.body).toBe("hello **world**");
    expect(view.message.createdAt).toEqual(new Date("2026-09-23T01:00:00Z"));
    expect(view.message.mentions).toEqual([]);
    expect(view.message.reactions).toBeUndefined();
  });

  test("maps a human sender with the Workspace avatar route when no CDN applies", () => {
    const view = savedMessageView(
      row({
        message: {
          sender: {
            userId: "55555555-5555-4555-8555-555555555555",
            agentId: null,
            user: {
              username: "frank",
              displayName: "Frank",
              avatarObjectKey: "users/55555555/a.png",
            },
            agent: null,
          },
        },
      }),
      WORKSPACE_ID,
    );
    expect(view.message.senderKind).toBe("user");
    expect(view.message.senderName).toBe("Frank");
    expect(view.message.senderHandle).toBe("frank");
    expect(view.message.senderAvatarUrl).toBe(
      `/api/workspaces/${WORKSPACE_ID}/users/55555555-5555-4555-8555-555555555555/avatar?v=55555555`,
    );
    expect(view.message.senderDeleted).toBe(false);
  });

  test("maps a deleted agent sender greyed and a system sender with no identity", () => {
    const agentView = savedMessageView(
      row({
        message: {
          senderMemberId: "66666666-6666-4666-8666-666666666666",
          sender: {
            userId: null,
            agentId: "77777777-7777-4777-8777-777777777777",
            user: null,
            agent: {
              name: "muse",
              displayName: "Muse",
              deletedAt: new Date("2026-09-20T00:00:00Z"),
              avatarObjectKey: null,
            },
          },
        },
      }),
      WORKSPACE_ID,
    );
    expect(agentView.message.senderKind).toBe("agent");
    expect(agentView.message.senderDeleted).toBe(true);
    expect(agentView.message.senderAgentId).toBe("77777777-7777-4777-8777-777777777777");

    const systemView = savedMessageView(
      row({
        message: {
          senderMemberId: null,
          sender: null,
        },
      }),
      WORKSPACE_ID,
    );
    expect(systemView.message.senderKind).toBe("system");
    expect(systemView.message.senderAvatarUrl).toBeNull();
    expect(systemView.message.senderName).toBe("System");
  });
});
