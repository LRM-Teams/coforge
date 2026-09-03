import { describe, expect, test } from "bun:test";
import { decodeAgentMessageDelivery } from "@coforge/protocol";
import {
  ReadDirectMessages,
  SendDirectMessage,
} from "../src/server/conversations/direct-message.server";
import type {
  MessageRequestIdempotency,
  MessageRequestScope,
} from "../src/server/conversations/message-request-idempotency.server";
import type { DirectConversationRepository } from "../src/server/db/repositories/direct-conversation.repositories.server";

const persisted = {
  id: "message-a",
  deliveryId: "delivery-a",
  body: "Hello Agent",
  createdAt: new Date("2026-08-28T00:00:00Z"),
  workspaceId: "workspace-a",
  computerId: "computer-a",
  agentId: "agent-a",
  sequence: 1,
  target: "@agent",
  latestSender: "@ada",
};

class MemoryMessageRequestIdempotency implements MessageRequestIdempotency {
  readonly results = new Map<string, typeof persisted>();

  async execute(scope: MessageRequestScope, persist: () => Promise<typeof persisted>) {
    const key = `${scope.workspaceId}:${scope.senderKind}:${scope.senderId}:${scope.requestId}`;
    const existing = this.results.get(key);
    if (existing) return existing;
    const message = await persist();
    this.results.set(key, message);
    return message;
  }
}

describe("SendDirectMessage", () => {
  test("persists before publishing the canonical message to its Workspace", async () => {
    const calls: string[] = [];
    let publication: { channel: string; data: Uint8Array } | undefined;
    const repository = {
      async getOrCreateUserAgent() {
        return { id: "conversation-a" };
      },
      async sendMessage() {
        calls.push("persist");
        return persisted;
      },
    } satisfies DirectConversationRepository;
    const useCase = new SendDirectMessage(repository, new MemoryMessageRequestIdempotency(), {
      async publish(channel, data) {
        calls.push("publish");
        publication = { channel, data };
      },
    });

    await useCase.execute({
      requestId: "request-a",
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      senderMemberId: "member-a",
      senderUserId: "user-a",
      body: "Hello Agent",
    });

    expect(calls).toEqual(["persist", "publish"]);
    expect(publication?.channel).toBe("daemon:computer-a");
    expect(decodeAgentMessageDelivery(publication!.data)).toEqual({
      protocolMajor: 1,
      requestId: "request-a",
      messageId: "message-a",
      deliveryId: "delivery-a",
      sequence: 1,
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      agentId: "agent-a",
      body: "Hello Agent",
      method: "agent:deliver",
      target: "@ada",
      latestSender: "@ada",
    });
    expect(JSON.stringify(decodeAgentMessageDelivery(publication!.data))).not.toContain("user-a");
  });

  test.each([undefined, "2c9d2c18-2a0b-4a95-9e5a-111111111111"])(
    "does not publish without a valid public sender target: %s",
    async (latestSender) => {
      let published = false;
      const repository = {
        async getOrCreateUserAgent() {
          return { id: "conversation-a" };
        },
        async sendMessage() {
          return { ...persisted, latestSender };
        },
      } satisfies DirectConversationRepository;
      const useCase = new SendDirectMessage(repository, new MemoryMessageRequestIdempotency(), {
        async publish() {
          published = true;
        },
      });

      await expect(
        useCase.execute({
          requestId: "request-a",
          workspaceId: "workspace-a",
          conversationId: "conversation-a",
          senderMemberId: "member-a",
          senderUserId: "user-a",
          body: "Hello Agent",
        }),
      ).rejects.toThrow("message sender must be a public @username");
      expect(published).toBe(false);
    },
  );

  test.each(["sender is not a conversation member", "conversation scope is not authorized"])(
    "does not publish when persistence rejects: %s",
    async (reason) => {
      let published = false;
      const repository = {
        async getOrCreateUserAgent() {
          return { id: "conversation-a" };
        },
        async sendMessage() {
          throw new Error(reason);
        },
      } satisfies DirectConversationRepository;
      const useCase = new SendDirectMessage(repository, new MemoryMessageRequestIdempotency(), {
        async publish() {
          published = true;
        },
      });
      await expect(
        useCase.execute({
          requestId: "request-a",
          workspaceId: "workspace-a",
          conversationId: "conversation-a",
          senderMemberId: "member-a",
          senderUserId: "user-a",
          body: "Hello Agent",
        }),
      ).rejects.toThrow(reason);
      expect(published).toBe(false);
    },
  );

  test("persists an Agent message without publishing to the Agent channel", async () => {
    const calls: string[] = [];
    const repository = {
      async sendMessage() {
        throw new Error("not used");
      },
      async userIdForUsername() {
        return "internal-user";
      },
      async getOrCreateUserAgent() {
        return { id: "conversation-a" };
      },
      async sendAgentMessage() {
        calls.push("persist");
        return { ...persisted, deliveryId: undefined, target: "@user" };
      },
    } satisfies DirectConversationRepository;
    const useCase = new SendDirectMessage(repository, new MemoryMessageRequestIdempotency(), {
      async publish() {
        calls.push("publish");
      },
    });

    await useCase.executeFromAgent({
      requestId: "request-a",
      workspaceId: "workspace-a",
      agentId: "agent-a",
      target: "@user",
      body: "Hi",
    });
    expect(calls).toEqual(["persist"]);
  });

  test("does not publish when Agent persistence fails", async () => {
    let published = false;
    const repository = {
      async sendMessage() {
        throw new Error("not used");
      },
      async userIdForUsername() {
        return "internal-user";
      },
      async getOrCreateUserAgent() {
        return { id: "conversation-a" };
      },
      async sendAgentMessage() {
        throw new Error("persistence failed");
      },
    } satisfies DirectConversationRepository;
    const useCase = new SendDirectMessage(repository, new MemoryMessageRequestIdempotency(), {
      async publish() {
        published = true;
      },
    });
    await expect(
      useCase.executeFromAgent({
        requestId: "request-a",
        workspaceId: "workspace-a",
        agentId: "agent-a",
        target: "@user",
        body: "Hi",
      }),
    ).rejects.toThrow("persistence failed");
    expect(published).toBe(false);
  });

  test("does not invoke publication even when the publication adapter fails", async () => {
    let persistedCalled = false;
    const repository = {
      async sendMessage() {
        throw new Error("not used");
      },
      async userIdForUsername() {
        return "internal-user";
      },
      async getOrCreateUserAgent() {
        return { id: "conversation-a" };
      },
      async sendAgentMessage() {
        persistedCalled = true;
        return { ...persisted, deliveryId: undefined, target: "@user" };
      },
    } satisfies DirectConversationRepository;
    const useCase = new SendDirectMessage(repository, new MemoryMessageRequestIdempotency(), {
      async publish() {
        throw new Error("should not be called");
      },
    });
    await expect(
      useCase.executeFromAgent({
        requestId: "request-a",
        workspaceId: "workspace-a",
        agentId: "agent-a",
        target: "@user",
        body: "Hi",
      }),
    ).resolves.toMatchObject({ id: "message-a", sequence: 1 });
    expect(persistedCalled).toBe(true);
  });

  test("same sender scope and requestId persists once and returns the same message", async () => {
    let persistenceCalls = 0;
    const repository = {
      async getOrCreateUserAgent() {
        return { id: "conversation-a" };
      },
      async sendMessage() {
        persistenceCalls += 1;
        return persisted;
      },
    } satisfies DirectConversationRepository;
    const useCase = new SendDirectMessage(repository, new MemoryMessageRequestIdempotency(), {
      async publish() {},
    });
    const input = {
      requestId: "request-a",
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      senderMemberId: "member-a",
      senderUserId: "user-a",
      body: "Hello Agent",
    };

    const first = await useCase.execute(input);
    const retry = await useCase.execute(input);

    expect(persistenceCalls).toBe(1);
    expect(retry).toEqual(first);
    expect(retry.createdAt).toBeInstanceOf(Date);
  });

  test("publish failure retry republishes the same persisted delivery", async () => {
    let persistenceCalls = 0;
    let publicationCalls = 0;
    const deliveries: string[] = [];
    const repository = {
      async getOrCreateUserAgent() {
        return { id: "conversation-a" };
      },
      async sendMessage() {
        persistenceCalls += 1;
        return persisted;
      },
    } satisfies DirectConversationRepository;
    const useCase = new SendDirectMessage(repository, new MemoryMessageRequestIdempotency(), {
      async publish(_channel, data) {
        publicationCalls += 1;
        deliveries.push(decodeAgentMessageDelivery(data).deliveryId);
        if (publicationCalls === 1) throw new Error("publication failed");
      },
    });
    const input = {
      requestId: "request-a",
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      senderMemberId: "member-a",
      senderUserId: "user-a",
      body: "Hello Agent",
    };

    await expect(useCase.execute(input)).rejects.toThrow("publication failed");
    await expect(useCase.execute(input)).resolves.toMatchObject({ id: "message-a" });

    expect(persistenceCalls).toBe(1);
    expect(deliveries).toEqual(["delivery-a", "delivery-a"]);
  });

  test("different requestIds persist distinct messages", async () => {
    let persistenceCalls = 0;
    const repository = {
      async getOrCreateUserAgent() {
        return { id: "conversation-a" };
      },
      async sendMessage() {
        persistenceCalls += 1;
        return { ...persisted, id: `message-${persistenceCalls}` };
      },
    } satisfies DirectConversationRepository;
    const useCase = new SendDirectMessage(repository, new MemoryMessageRequestIdempotency(), {
      async publish() {},
    });
    const input = {
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      senderMemberId: "member-a",
      senderUserId: "user-a",
      body: "Hello Agent",
    };

    const first = await useCase.execute({ ...input, requestId: "request-a" });
    const second = await useCase.execute({ ...input, requestId: "request-b" });

    expect(persistenceCalls).toBe(2);
    expect(second.id).not.toBe(first.id);
  });

  test("User and Agent request scopes do not collide", async () => {
    let userPersistenceCalls = 0;
    let agentPersistenceCalls = 0;
    const repository = {
      async sendMessage() {
        userPersistenceCalls += 1;
        return persisted;
      },
      async userIdForUsername() {
        return "user-a";
      },
      async getOrCreateUserAgent() {
        return { id: "conversation-a" };
      },
      async sendAgentMessage() {
        agentPersistenceCalls += 1;
        return { ...persisted, id: "agent-message", deliveryId: undefined, target: "@user" };
      },
    } satisfies DirectConversationRepository;
    const useCase = new SendDirectMessage(repository, new MemoryMessageRequestIdempotency(), {
      async publish() {},
    });

    await useCase.execute({
      requestId: "same-request",
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      senderMemberId: "member-a",
      senderUserId: "shared-stable-id",
      body: "User message",
    });
    await useCase.executeFromAgent({
      requestId: "same-request",
      workspaceId: "workspace-a",
      agentId: "shared-stable-id",
      target: "@user",
      body: "Agent message",
    });

    expect(userPersistenceCalls).toBe(1);
    expect(agentPersistenceCalls).toBe(1);
  });
});

describe("ReadDirectMessages", () => {
  test("coordinates target lookup and conversation selection before reading persisted messages", async () => {
    const calls: string[] = [];
    const messages = [
      {
        id: "message-a",
        sequence: 1,
        sender: "@ada",
        body: "Hello",
        createdAt: new Date("2026-08-28T00:00:00Z"),
        target: "@user",
      },
    ];
    const repository = {
      async userIdForUsername(target: string) {
        calls.push(`lookup:${target}`);
        return "user-a";
      },
      async getOrCreateUserAgent(workspaceId: string, userId: string, agentId: string) {
        calls.push(`conversation:${workspaceId}:${userId}:${agentId}`);
        return { id: "conversation-a" };
      },
      async sendMessage() {
        throw new Error("not used");
      },
      async readMessagesForConversation(conversationId: string) {
        calls.push(`read:${conversationId}`);
        return messages;
      },
    } satisfies DirectConversationRepository;

    await expect(
      new ReadDirectMessages(repository).execute({
        workspaceId: "workspace-a",
        agentId: "agent-a",
        target: "@user",
      }),
    ).resolves.toEqual(messages);
    expect(calls).toEqual([
      "lookup:@user",
      "conversation:workspace-a:user-a:agent-a",
      "read:conversation-a",
    ]);
  });
});
