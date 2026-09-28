import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import {
  enrollGeneralChannel,
  getAgentChannel,
  PublicChannels,
} from "#src/server/conversations/public-channels.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";
import { AgentChannelManagement } from "#src/server/conversations/agent-channel-management.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { findMessageSearchIds } from "#src/server/db/repositories/message-search.repositories.server";
import {
  listUserSavedMessages,
  saveUserMessage,
} from "#src/server/conversations/saved-messages.server";
import { storeMessageBody } from "#src/server/conversations/message-references.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

/**
 * A Workspace owner or admin can hide `#general` from the whole Workspace and restore it. While
 * it is hidden it is gone for everyone, owners included: no channel list, page, post, join,
 * member list, history, search, Saved row, `#general` reference, Task scope or Agent channel
 * surface shows it. Its history is kept, and enrollment keeps running, so restoring brings it back
 * whole. Drives the real services against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error.code;
    if (error instanceof Error && "status" in error) return `status:${String(error.status)}`;
    if (error instanceof Error) return error.name;
    throw error;
  }
  return undefined;
}

test.skipIf(!connectionString)(
  "a hidden #general disappears from every surface, for owners too, and restoring brings it back whole",
  async () => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
    const suffix = crypto.randomUUID().slice(0, 8);
    const owner = await db.user.create({ data: { username: `hide-owner-${suffix}` } });
    const bob = await db.user.create({ data: { username: `hide-bob-${suffix}` } });
    const late = await db.user.create({ data: { username: `hide-late-${suffix}` } });
    const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
      slug: `hide-${suffix}`,
      name: "Hide general",
      userId: owner.id,
    });
    const updated: string[] = [];
    const realtime: ConversationRealtime = {
      async messageAvailable() {},
      async memberChanged() {},
      async channelUpdated(input) {
        updated.push(input.conversationId);
      },
    };
    try {
      await db.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: bob.id, role: "member" },
      });
      await enrollGeneralChannel(db, workspace.id);
      const agent = await new PrismaAgentRepository(db).create({
        workspaceId: workspace.id,
        name: `hide-agent-${suffix}`,
        displayName: "Helper",
        ownerId: owner.id,
        runtimeConfig: {
          runtime: "pi",
          provider: { kind: "default" },
          model: "",
          modelProvider: "",
          reasoning: "",
        },
      });
      const channels = new PublicChannels(db, undefined, undefined, undefined, realtime);
      const general = await db.conversation.findUniqueOrThrow({
        where: { workspaceId_channelName: { workspaceId: workspace.id, channelName: "general" } },
      });
      const team = await channels.create(workspace.id, owner.id, `team-${suffix}`);
      const ownerRow = await db.conversationMember.findUniqueOrThrow({
        where: { conversationId_userId: { conversationId: general.id, userId: owner.id } },
      });
      const history = await db.message.create({
        data: {
          workspaceId: workspace.id,
          conversationId: general.id,
          senderMemberId: ownerRow.id,
          sequence: 1,
          body: `hidden-history-${suffix} history`,
        },
      });
      // A message waiting for the Agent (it is muted in #general; a personal mention reaches it).
      const mention = await db.message.create({
        data: {
          workspaceId: workspace.id,
          conversationId: general.id,
          senderMemberId: ownerRow.id,
          sequence: 2,
          body: `for the agent ${suffix}`,
        },
      });
      await db.agentMessageDelivery.create({
        data: {
          workspaceId: workspace.id,
          conversationId: general.id,
          messageId: mention.id,
          agentId: agent.id,
          sequence: 2,
        },
      });
      const repo = new PrismaDirectConversationRepository(db);
      const pending = async () =>
        (await repo.readPendingAgentDeliveries(workspace.id, agent.id)).map((row) => row.messageId);
      expect(await pending()).toEqual([mention.id]);
      await saveUserMessage(db, {
        workspaceId: workspace.id,
        conversationId: general.id,
        userId: bob.id,
        messageId: history.id,
      });
      const search = (userId: string) =>
        findMessageSearchIds(db, {
          workspaceId: workspace.id,
          viewerUserId: userId,
          terms: [`hidden-history-${suffix}`],
          query: `hidden-history-${suffix}`,
          sort: "recent",
          limit: 10,
          offset: 0,
        });
      const management = new AgentChannelManagement(db, undefined, channels);
      const agentSearch = () =>
        new PrismaDirectConversationRepository(db).searchMessages(workspace.id, agent.id, {
          // Full-text search reads `-` as an operator; one plain word finds the message.
          query: "history",
        });
      const board = new TaskBoard(db);
      const reference = () =>
        db.$transaction((tx) =>
          storeMessageBody(
            tx,
            { workspaceId: workspace.id, conversationId: team.id },
            "see #general",
            { targets: [] },
          ),
        );

      // Only a Workspace owner or admin hides it, and only they are offered to.
      expect((await channels.open(workspace.id, owner.id, general.id)).canHideGeneral).toBe(true);
      expect((await channels.open(workspace.id, bob.id, general.id)).canHideGeneral).toBe(false);
      expect((await channels.open(workspace.id, owner.id, team.id)).canHideGeneral).toBe(false);
      expect(await errorOf(channels.setGeneralHidden(workspace.id, bob.id, true))).toBe(
        "ACCESS_DENIED",
      );
      expect(await channels.generalHidden(workspace.id, owner.id)).toBe(false);
      await channels.setGeneralHidden(workspace.id, owner.id, true);
      expect(await channels.generalHidden(workspace.id, owner.id)).toBe(true);
      expect(updated).toEqual([general.id]);

      // Gone from every surface, for the owner who hid it too.
      for (const viewer of [owner.id, bob.id]) {
        expect((await channels.list(workspace.id, viewer)).map((row) => row.id)).not.toContain(
          general.id,
        );
        expect((await channels.names(workspace.id, viewer)).map((row) => row.id)).not.toContain(
          general.id,
        );
        expect(await errorOf(channels.open(workspace.id, viewer, general.id))).toBe("NOT_FOUND");
        expect(await search(viewer)).toEqual([]);
      }
      expect(
        await errorOf(
          channels.send({
            workspaceId: workspace.id,
            userId: owner.id,
            channelId: general.id,
            requestId: crypto.randomUUID(),
            body: "anyone there?",
          }),
        ),
      ).toBe("NOT_FOUND");
      expect(await errorOf(channels.join(workspace.id, bob.id, general.id))).toBe("NOT_FOUND");
      expect(await errorOf(channels.members(workspace.id, { userId: owner.id }, general.id))).toBe(
        "NOT_FOUND",
      );
      expect(
        await errorOf(
          new ConversationHistory(db).listOwnMessages(workspace.id, owner.id, general.id),
        ),
      ).toBe("NOT_FOUND");
      expect(
        await listUserSavedMessages(db, { workspaceId: workspace.id, userId: bob.id }),
      ).toEqual([]);
      expect((await reference()).body).toBe("see #general");
      expect(
        await errorOf(
          board.execute(
            { workspaceId: workspace.id, userId: owner.id },
            { operation: "list", conversationId: general.id, idempotencyKey: crypto.randomUUID() },
          ),
        ),
      ).toBe("NOT_FOUND");
      // Agent surfaces: `#general` is an unknown channel.
      expect(await errorOf(getAgentChannel(db, workspace.id, agent.id, "#general"))).toBeDefined();
      expect(await errorOf(management.info(workspace.id, agent.id, "#general"))).toBe("status:404");
      expect(await errorOf(management.join(workspace.id, agent.id, "#general"))).toBe("status:404");
      expect(await agentSearch()).toEqual([]);
      // Its waiting deliveries hold until it is back, and its messages resolve to nothing.
      expect(await pending()).toEqual([]);
      expect(await errorOf(repo.resolveAgentMessage(workspace.id, agent.id, history.id))).toBe(
        "AgentMessageValidationError",
      );
      expect(await errorOf(management.leave(workspace.id, agent.id, "#general"))).toBe(
        "status:404",
      );

      // Enrollment keeps running while hidden, so a later member is in it once it is restored.
      await db.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: late.id, role: "member" },
      });
      await enrollGeneralChannel(db, workspace.id);

      await channels.setGeneralHidden(workspace.id, owner.id, false);
      expect(await channels.generalHidden(workspace.id, owner.id)).toBe(false);
      expect(updated).toEqual([general.id, general.id]);
      expect(
        (await channels.list(workspace.id, late.id)).find((row) => row.id === general.id),
      ).toMatchObject({ joined: true });
      expect(
        (await channels.open(workspace.id, bob.id, general.id)).messages.map((m) => m.id),
      ).toContain(history.id);
      expect(await search(bob.id)).toEqual([history.id]);
      expect(
        (await listUserSavedMessages(db, { workspaceId: workspace.id, userId: bob.id })).length,
      ).toBe(1);
      expect((await reference()).body).toBe(`see <@channel:${general.id}:general>`);
      expect((await management.info(workspace.id, agent.id, "#general")).name).toBe("#general");
      expect((await agentSearch()).map((row) => row.id)).toEqual([history.id]);
      expect(await pending()).toEqual([mention.id]);
      expect((await repo.resolveAgentMessage(workspace.id, agent.id, history.id)).id).toBe(
        history.id,
      );

      // Hiding or restoring again changes and announces nothing.
      await channels.setGeneralHidden(workspace.id, owner.id, false);
      expect(updated).toHaveLength(2);
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.user.deleteMany({ where: { id: { in: [owner.id, bob.id, late.id] } } });
      await db.$disconnect();
    }
  },
);
