import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";
import { isAppError } from "../src/lib/app-error";
import { toggleUserMessageReaction } from "../src/server/conversations/user-message-reactions.server";

const input = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  userId: "user-1",
  messageId: "message-1",
  emoji: "👍",
  active: true,
};

function reactionRow(emoji: string, username: string) {
  return { emoji, member: { agentId: null, agent: null, user: { username } } };
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
      remaining: [reactionRow("🎉", "alice"), reactionRow("👍", "bob"), reactionRow("👍", "carol")],
    });
    const summaries = await toggleUserMessageReaction(db, input);
    expect(calls).toEqual(["message", "member", "upsert", "summaries"]);
    expect(summaries).toEqual([
      { emoji: "🎉", count: 1, reactors: ["@alice"] },
      { emoji: "👍", count: 2, reactors: ["@bob", "@carol"] },
    ]);
  });

  test("deletes on inactive and reports no summaries once the last one is gone", async () => {
    const { db, calls } = fakeDb({ remaining: [] });
    const summaries = await toggleUserMessageReaction(db, { ...input, active: false });
    expect(calls).toEqual(["message", "member", "delete", "summaries"]);
    expect(summaries).toBeUndefined();
  });
});
