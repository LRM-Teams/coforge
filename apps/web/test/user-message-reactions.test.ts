import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import { toggleUserMessageReaction } from "#src/server/conversations/user-message-reactions.server";

const input = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  userId: "user-1",
  messageId: "message-1",
  emoji: "👍",
  active: true,
};

/** A reaction by a person: `userId` is who they are, `names` their profile. */
function reactionRow(
  emoji: string,
  userId: string,
  names: { username: string; displayName?: string; fullName?: string },
) {
  return {
    emoji,
    member: {
      userId,
      agentId: null,
      agent: null,
      user: { displayName: null, fullName: null, ...names },
    },
  };
}

function agentReactionRow(emoji: string, name: string) {
  return { emoji, member: { userId: null, agentId: `agent-${name}`, agent: { name }, user: null } };
}

function fakeDb(
  overrides: {
    message?: unknown;
    member?: unknown;
    remaining?: unknown[];
  } = {},
) {
  const calls: string[] = [];
  const db = {
    message: {
      findFirst: async (_query: object) => {
        calls.push("message");
        return "message" in overrides ? overrides.message : { id: "message-1" };
      },
    },
    conversationMember: {
      findFirst: async (_query: object) => {
        calls.push("member");
        return "member" in overrides ? overrides.member : { id: "member-1" };
      },
    },
    messageReaction: {
      upsert: async () => {
        calls.push("upsert");
      },
      deleteMany: async () => {
        calls.push("delete");
      },
      findMany: async () => {
        calls.push("summaries");
        return overrides.remaining ?? [];
      },
    },
  } as unknown as PrismaClient;
  return { db, calls };
}

async function appErrorCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
  return undefined;
}

describe("toggleUserMessageReaction", () => {
  test("rejects an invalid emoji before touching the database", async () => {
    const { db, calls } = fakeDb();
    const code = await appErrorCode(() =>
      toggleUserMessageReaction(db, { ...input, emoji: "not an emoji" }),
    );
    expect(code).toBe("INVALID_INPUT");
    expect(calls).toEqual([]);
  });

  test("reports a message outside the conversation as not found", async () => {
    const { db, calls } = fakeDb({ message: null });
    const code = await appErrorCode(() => toggleUserMessageReaction(db, input));
    expect(code).toBe("NOT_FOUND");
    expect(calls).toEqual(["message"]);
  });

  test("denies a reader without an active membership", async () => {
    const { db, calls } = fakeDb({ member: null });
    const code = await appErrorCode(() => toggleUserMessageReaction(db, input));
    expect(code).toBe("ACCESS_DENIED");
    expect(calls).toEqual(["message", "member"]);
  });

  test("upserts on active and returns the fresh summaries in first-reaction order", async () => {
    const { db, calls } = fakeDb({
      remaining: [
        reactionRow("🎉", "user-alice", { username: "alice-3f9", fullName: "Alice Chen" }),
        reactionRow("👍", "user-bob", { username: "bob-7q1", fullName: "Bob Okafor" }),
        reactionRow("👍", "user-carol", { username: "carol-2xa", fullName: "Carol Diaz" }),
      ],
    });
    const summaries = await toggleUserMessageReaction(db, input);
    expect(calls).toEqual(["message", "member", "upsert", "summaries"]);
    expect(summaries).toEqual([
      { emoji: "🎉", count: 1, reactors: [{ id: "user-alice", label: "Alice Chen" }] },
      {
        emoji: "👍",
        count: 2,
        reactors: [
          { id: "user-bob", label: "Bob Okafor" },
          { id: "user-carol", label: "Carol Diaz" },
        ],
      },
    ]);
  });

  test("names a person by their label, never their username, and an Agent by its @handle", async () => {
    const { db } = fakeDb({
      remaining: [
        reactionRow("👍", "user-1", {
          username: "frank-an-4k2",
          displayName: "Frankie",
          fullName: "Frank An",
        }),
        reactionRow("👍", "user-2", { username: "ada-9d3", fullName: "Ada Lovelace" }),
        agentReactionRow("👍", "atlas"),
      ],
    });
    const summaries = await toggleUserMessageReaction(db, input);
    expect(summaries?.[0]?.reactors).toEqual([
      { id: "user-1", label: "Frankie" },
      { id: "user-2", label: "Ada Lovelace" },
      { id: "agent-atlas", label: "@atlas" },
    ]);
    expect(JSON.stringify(summaries)).not.toContain("frank-an-4k2");
    expect(JSON.stringify(summaries)).not.toContain("ada-9d3");
  });

  test("deletes on inactive and reports no summaries once the last one is gone", async () => {
    const { db, calls } = fakeDb({ remaining: [] });
    const summaries = await toggleUserMessageReaction(db, { ...input, active: false });
    expect(calls).toEqual(["message", "member", "delete", "summaries"]);
    expect(summaries).toBeUndefined();
  });
});
