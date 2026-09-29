import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import { prepareDaemonApiKey } from "#src/server/auth/daemon-api-key.server";
import { DaemonCredentialRevocations } from "#src/server/db/repositories/daemon-credential-revocation.repositories.server";
import { PrismaOpenVikingBindingStore } from "#src/server/db/repositories/openviking-binding.repositories.server";
import { PrismaWorkspaceMemoryCleanupStore } from "#src/server/db/repositories/workspace-memory-cleanup.repositories.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import {
  createFakeWorkspaceMemoryCleanupRemotes,
  createWorkspaceMemoryCleanup,
} from "#src/server/workspace-memory/cleanup.server";
import { createProductionWorkspaceMemoryCleanupRemotes } from "#src/server/workspace-memory/cleanup-remotes.server";
import {
  PrismaWorkspaceCatalogStore,
  WorkspaceCatalog,
} from "#src/server/workspaces/catalog.server";
import { WorkspaceDeparture } from "#src/server/workspaces/departure.server";
import {
  WORKSPACE_MEMORY_REMOVAL_OPERATION_ID,
  WorkspaceDeletion,
  workspaceMemoryRemoval,
  type WorkspaceDeletionSignals,
  type WorkspaceFileRemoval,
} from "#src/server/workspaces/deletion.server";

/**
 * A Workspace's owner deletes it for good: everything in it goes — what its members wrote, their
 * Tasks, the Action cards its Agents prepared, files, Reminders, Records — its Computers learn it is
 * gone the next time they connect, and every open page leaves it. Nobody else may, and the owner
 * must type its slug. Drives the real services against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

async function errorOf(promise: Promise<unknown>) {
  return (await errorIdOf(promise))?.code;
}

async function errorIdOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return { code: error.code, errorId: error.errorId };
    throw error;
  }
  return undefined;
}

const silentRealtime: ConversationRealtime = {
  async messageAvailable() {},
  async memberChanged() {},
};

/** File removal that records what it was asked, and finishes only when released: the delete
 * must answer without waiting for it. */
function recordingFileRemoval() {
  const calls: { workspaceId: string; files: string[]; images: string[] }[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const removal: WorkspaceFileRemoval = {
    remove(workspaceId, keys) {
      calls.push({ workspaceId, files: [...keys.files].sort(), images: [...keys.images].sort() });
      return released;
    },
  };
  return { calls, removal, release };
}

/** Signals that record who heard of the delete. */
function recordingSignals() {
  const deleted: string[] = [];
  const reconnected: { workspaceId: string; computerIds: string[] }[] = [];
  const signals: WorkspaceDeletionSignals = {
    async workspaceDeleted(workspaceId) {
      deleted.push(workspaceId);
    },
    async reconnectDaemons(workspaceId, computerIds) {
      reconnected.push({ workspaceId, computerIds: [...computerIds] });
    },
  };
  return { deleted, reconnected, signals };
}

/** A deletion whose effects go nowhere, for tests about the rows. */
function quietDeletion(db: PrismaClient) {
  return new WorkspaceDeletion(db, {
    files: recordingFileRemoval().removal,
    signals: recordingSignals().signals,
    memory: unboundMemory(db).memory,
  });
}

/** Memory removal over the real cleanup rows whose remotes only record their calls: what a
 * Workspace with no memory must never reach. */
function unboundMemory(db: PrismaClient) {
  const remotes = createFakeWorkspaceMemoryCleanupRemotes();
  const memory = createWorkspaceMemoryCleanup({
    store: new PrismaWorkspaceMemoryCleanupStore(db),
    remotes,
  });
  return { remotes, memory };
}

const OPENVIKING_URL = "http://openviking.test:1933";
const OPENVIKING_ADMIN_KEY = "root-key-held-by-the-server";

/**
 * Memory removal as production composes it (the real cleanup rows, binding rows and OpenViking
 * client), handed an admin identity the way a provisioner will, with the HTTP to OpenViking
 * recorded and answered with `status`. Each request notes how many messages the Workspace still
 * had when it was sent: the account goes before any row does.
 */
function openVikingMemory(db: PrismaClient, workspaceId: string) {
  const openviking = {
    status: 202,
    requests: [] as {
      method: string | undefined;
      url: string;
      authorization: string | null;
      messagesLeft: number;
    }[],
  };
  const remotes = createProductionWorkspaceMemoryCleanupRemotes({
    bindings: new PrismaOpenVikingBindingStore(db),
    openviking: {
      baseUrl: OPENVIKING_URL,
      adminIdentity: {
        accountId: "root",
        userId: "cleanup-admin",
        role: "admin",
        authorization: `Bearer ${OPENVIKING_ADMIN_KEY}`,
      },
      fetchImpl: async (input, init) => {
        openviking.requests.push({
          method: init?.method,
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
          messagesLeft: await db.message.count({ where: { workspaceId } }),
        });
        return new Response(null, { status: openviking.status });
      },
    },
  });
  return {
    openviking,
    memory: createWorkspaceMemoryCleanup({
      store: new PrismaWorkspaceMemoryCleanupStore(db),
      remotes,
    }),
  };
}

/** The Workspace's memory as OpenViking holds it: a binding and a mapped identity under it. */
async function bindMemory(db: PrismaClient, workspaceId: string) {
  await db.openVikingBinding.create({
    data: {
      workspaceId,
      accountId: `acct-${workspaceId}`,
      serviceIdentityId: "svc",
      credentialRef: "secret:ov",
      generation: 1,
    },
  });
  await db.openVikingMappedIdentity.create({
    data: {
      workspaceId,
      actorKind: "projection_worker",
      actorSubject: "projection",
      openvikingUserId: "svc-projection",
      role: "service",
      access: "projection_only",
      generation: 1,
    },
  });
}

/** A Workspace in use: an owner, an admin and a member who wrote in a channel, an Agent on a
 * Computer with a live daemon key, and one of everything that hangs off them. */
async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({ data: { username: `wd-owner-${suffix}` } });
  const admin = await db.user.create({ data: { username: `wd-admin-${suffix}` } });
  const member = await db.user.create({ data: { username: `wd-member-${suffix}` } });
  const catalog = new PrismaWorkspaceCatalogStore(db);
  const workspace = await catalog.createForUser({
    slug: `wd-${suffix}`,
    name: "Doomed",
    userId: owner.id,
  });
  await db.workspaceMembership.createMany({
    data: [
      { workspaceId: workspace.id, userId: admin.id, role: "admin" },
      { workspaceId: workspace.id, userId: member.id, role: "member" },
    ],
  });
  const computer = await db.computer.create({
    data: { ownerId: owner.id, machineId: `machine-${suffix}` },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  const liveKey = prepareDaemonApiKey({
    principal: { userId: owner.id },
    workspaceId: workspace.id,
    computerId: computer.id,
  });
  await db.daemonApiKey.create({ data: liveKey.record });
  const agentAvatarKey = `workspaces/${workspace.id}/agents/a/avatars/${crypto.randomUUID()}/original`;
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      name: `wd-agent-${suffix}`,
      displayName: "Helper",
      ownerId: owner.id,
      computerId: computer.id,
      avatarObjectKey: agentAvatarKey,
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  const workspaceIconKey = `workspaces/${workspace.id}/icons/${crypto.randomUUID()}/original`;
  await db.workspace.update({
    where: { id: workspace.id },
    data: { iconObjectKey: workspaceIconKey, iconContentType: "image/png" },
  });
  const projectIconKey = `workspaces/${workspace.id}/projects/p/icons/${crypto.randomUUID()}/original`;
  await db.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Site",
      slug: `site-${suffix}`,
      iconObjectKey: projectIconKey,
      iconContentType: "image/png",
    },
  });

  const channels = new PublicChannels(db, undefined, undefined, undefined, silentRealtime);
  const team = await channels.create(workspace.id, member.id, `team-${suffix}`);
  await channels.addMembers(workspace.id, { userId: member.id }, team.id, {
    userIds: [],
    agentIds: [agent.id],
  });
  // The channel's coordinator names the Agent without cascading (`NO ACTION`).
  await db.conversation.update({ where: { id: team.id }, data: { coordinatorAgentId: agent.id } });
  const memberRow = await db.conversationMember.findUniqueOrThrow({
    where: { conversationId_userId: { conversationId: team.id, userId: member.id } },
  });
  const agentRow = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: team.id, agentId: agent.id },
  });
  const written = await db.message.create({
    data: {
      workspaceId: workspace.id,
      conversationId: team.id,
      senderMemberId: memberRow.id,
      sequence: 1,
      body: "the member wrote this",
    },
  });
  await db.message.create({
    data: {
      workspaceId: workspace.id,
      conversationId: team.id,
      senderMemberId: memberRow.id,
      sequence: 2,
      body: "and replied",
      threadRootId: written.id,
    },
  });
  await new TaskBoard(db).execute(
    { workspaceId: workspace.id, userId: member.id },
    {
      operation: "create",
      conversationId: team.id,
      title: "a task the member owns",
      idempotencyKey: crypto.randomUUID(),
      assignee: `@${member.username}`,
    },
  );
  const prepared = await db.message.create({
    data: {
      workspaceId: workspace.id,
      conversationId: team.id,
      senderMemberId: agentRow.id,
      sequence: 10,
      body: "shall I create a channel?",
    },
  });
  await db.actionCard.create({
    data: {
      messageId: prepared.id,
      conversationId: team.id,
      workspaceId: workspace.id,
      kind: "channel:create",
      payload: { name: "later" },
      preparedByAgentId: agent.id,
    },
  });
  const attachmentKey = `workspaces/${workspace.id}/attachments/${crypto.randomUUID()}/original`;
  await db.attachment.create({
    data: {
      workspaceId: workspace.id,
      conversationId: team.id,
      messageId: written.id,
      fileName: "notes.txt",
      contentType: "text/plain",
      sizeBytes: 4,
      objectKey: attachmentKey,
    },
  });
  const uploadKey = `workspaces/${workspace.id}/attachments/${crypto.randomUUID()}/original`;
  await db.attachmentUploadSession.create({
    data: {
      workspaceId: workspace.id,
      conversationId: team.id,
      agentId: agent.id,
      attachmentId: crypto.randomUUID(),
      objectKey: uploadKey,
      fileName: "draft.txt",
      contentType: "text/plain",
      sizeBytes: 5,
      idempotencyKey: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  await db.reminder.create({
    data: {
      workspaceId: workspace.id,
      ownerAgentId: agent.id,
      computerId: computer.id,
      title: "ping",
      target: `#team-${suffix}`,
      messageId: written.id,
      fireAt: new Date(Date.now() + 3_600_000),
    },
  });
  const cycle = await db.weeklyReportCycle.create({
    data: { workspaceId: workspace.id, year: 2026, week: 40, title: "W40", createdById: member.id },
  });
  await db.weeklyReport.create({
    data: {
      workspaceId: workspace.id,
      cycleId: cycle.id,
      authorId: member.id,
      kind: "member",
      title: "My week",
      content: {},
    },
  });
  await db.recordNote.create({
    data: { workspaceId: workspace.id, authorId: member.id, title: "note" },
  });
  // A Memory Offer citing a memory record: the citation names the record with `Restrict`.
  await db.openVikingCitationRecord.create({
    data: {
      workspaceId: workspace.id,
      citationId: "cite-1",
      accountId: "acct",
      uri: "viking://x",
      matchedLevel: "L1",
      contentHash: "sha256:x",
      title: "A remembered decision",
      boundOperationId: "op-1",
    },
  });
  await db.memoryOfferRecord.create({
    data: {
      workspaceId: workspace.id,
      operationId: "offer-1",
      conversationId: team.id,
      recipientAgentId: agent.id,
      recipientRationale: "asked",
      messageId: written.id,
    },
  });
  await db.memoryOfferCitation.create({
    data: {
      workspaceId: workspace.id,
      offerOperationId: "offer-1",
      citationKind: "openviking",
      citationId: "cite-1",
      openvikingCitationId: "cite-1",
    },
  });

  const cleanup = async () => {
    // A Workspace left behind by a failed test keeps its cleanup rows with `Restrict`.
    await db.workspaceMemoryCleanupWork
      .deleteMany({ where: { workspaceId: workspace.id } })
      .catch(() => {});
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.daemonCredentialRevocation
      .deleteMany({ where: { apiKeyHash: liveKey.record.apiKeyHash } })
      .catch(() => {});
    await db.computer.deleteMany({ where: { ownerId: owner.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, admin.id, member.id] } } });
    await db.$disconnect();
  };
  return {
    db,
    workspace,
    owner,
    admin,
    member,
    liveKeyHash: liveKey.record.apiKeyHash,
    computerId: computer.id,
    team,
    memberRowId: memberRow.id,
    privateKeys: [attachmentKey, uploadKey],
    imageKeys: [workspaceIconKey, projectIconKey, agentAvatarKey],
    cleanup,
  };
}

test.skipIf(!connectionString)(
  "the owner deletes a Workspace in use and everything in it goes; its Computers and open pages hear of it and its files are removed",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    const files = recordingFileRemoval();
    const heard = recordingSignals();
    try {
      // Resolves while the file removal is still running: it happens after the answer.
      await new WorkspaceDeletion(db, {
        files: files.removal,
        signals: heard.signals,
        memory: unboundMemory(db).memory,
      }).delete({ workspaceId: workspace.id, userId: owner.id, confirmSlug: workspace.slug });

      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
      for (const count of [
        db.message.count({ where: { workspaceId: workspace.id } }),
        db.task.count({ where: { workspaceId: workspace.id } }),
        db.actionCard.count({ where: { workspaceId: workspace.id } }),
        db.agent.count({ where: { workspaceId: workspace.id } }),
        db.conversation.count({ where: { workspaceId: workspace.id } }),
        db.workspaceMembership.count({ where: { workspaceId: workspace.id } }),
        db.daemonApiKey.count({ where: { workspaceId: workspace.id } }),
        db.reminder.count({ where: { workspaceId: workspace.id } }),
        db.weeklyReport.count({ where: { workspaceId: workspace.id } }),
      ])
        expect(await count).toBe(0);
      // Its Computer stays the owner's; only the link to the Workspace went.
      expect(await db.computer.count({ where: { ownerId: owner.id } })).toBe(1);
      // The Computer's key now answers why it stopped working.
      expect(await new DaemonCredentialRevocations(db).reasonFor(fixture.liveKeyHash)).toBe(
        "workspace_deleted",
      );
      expect(files.calls).toEqual([
        {
          workspaceId: workspace.id,
          files: [...fixture.privateKeys].sort(),
          images: [...fixture.imageKeys].sort(),
        },
      ]);
      expect(heard.deleted).toEqual([workspace.id]);
      expect(heard.reconnected).toEqual([
        { workspaceId: workspace.id, computerIds: [fixture.computerId] },
      ]);
    } finally {
      files.release();
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "only the owner deletes, and only with the Workspace's own slug; nothing changes otherwise",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner, admin, member } = fixture;
    const files = recordingFileRemoval();
    const heard = recordingSignals();
    const deletion = new WorkspaceDeletion(db, {
      files: files.removal,
      signals: heard.signals,
      memory: unboundMemory(db).memory,
    });
    const stranger = await db.user.create({
      data: { username: `wd-stranger-${crypto.randomUUID().slice(0, 8)}` },
    });
    const messages = () => db.message.count({ where: { workspaceId: workspace.id } });
    const messagesBefore = await messages();
    try {
      for (const userId of [admin.id, member.id, stranger.id])
        expect(
          await errorOf(
            deletion.delete({ workspaceId: workspace.id, userId, confirmSlug: workspace.slug }),
          ),
        ).toBe("ACCESS_DENIED");
      for (const confirmSlug of [
        "",
        workspace.name,
        workspace.slug.toUpperCase(),
        ` ${workspace.slug}`,
      ])
        expect(
          await errorOf(
            deletion.delete({ workspaceId: workspace.id, userId: owner.id, confirmSlug }),
          ),
        ).toBe("INVALID_INPUT");

      // A Workspace that is gone already (deleted from another tab) is not found.
      expect(
        await errorOf(
          deletion.delete({
            workspaceId: crypto.randomUUID(),
            userId: owner.id,
            confirmSlug: workspace.slug,
          }),
        ),
      ).toBe("NOT_FOUND");

      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).not.toBeNull();
      expect(await messages()).toBe(messagesBefore);
      expect(await db.daemonApiKey.count({ where: { workspaceId: workspace.id } })).toBe(1);
      expect(
        await new DaemonCredentialRevocations(db).reasonFor(fixture.liveKeyHash),
      ).toBeUndefined();
      expect(files.calls).toEqual([]);
      expect(heard.deleted).toEqual([]);
      expect(heard.reconnected).toEqual([]);
    } finally {
      await db.user.delete({ where: { id: stranger.id } });
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "the delete stands when file removal and the realtime signals fail after it",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    const failing: WorkspaceDeletionSignals = {
      async workspaceDeleted() {
        throw new Error("Centrifugo down");
      },
      async reconnectDaemons() {
        throw new Error("Centrifugo down");
      },
    };
    try {
      await new WorkspaceDeletion(db, {
        files: { remove: () => Promise.reject(new Error("bucket refused")) },
        signals: failing,
        memory: unboundMemory(db).memory,
      }).delete({ workspaceId: workspace.id, userId: owner.id, confirmSlug: workspace.slug });

      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
      expect(await new DaemonCredentialRevocations(db).reasonFor(fixture.liveKeyHash)).toBe(
        "workspace_deleted",
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "after deleting, the owner goes to the next Workspace they are in and `/` remembers it, or nowhere and `/` forgets",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    const other = await db.workspace.create({
      data: {
        slug: `wd-next-${crypto.randomUUID().slice(0, 8)}`,
        name: "Next",
        members: { create: { userId: owner.id, role: "member" } },
      },
    });
    const remembered: { slug?: string } = { slug: workspace.slug };
    const departure = new WorkspaceDeparture(
      new WorkspaceCatalog(new PrismaWorkspaceCatalogStore(db)),
      {
        read: () => remembered.slug,
        remember: (slug) => {
          remembered.slug = slug;
        },
        forget: () => {
          remembered.slug = undefined;
        },
      },
    );
    const deletion = quietDeletion(db);
    // The Delete Workspace server function's own call.
    const deleteAndGo = (target: { id: string; slug: string }) =>
      departure.delete(deletion, {
        workspaceId: target.id,
        userId: owner.id,
        confirmSlug: target.slug,
      });
    try {
      expect(await deleteAndGo(workspace)).toEqual({ nextWorkspaceSlug: other.slug });
      expect(remembered.slug).toBe(other.slug);

      // A refused delete goes nowhere and `/` keeps what it remembered.
      await expect(deleteAndGo(other)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      expect(remembered.slug).toBe(other.slug);

      await db.workspace.delete({ where: { id: other.id } });
      expect(await departure.next(owner.id)).toEqual({ nextWorkspaceSlug: null });
      expect(remembered.slug).toBeUndefined();
    } finally {
      await db.workspace.delete({ where: { id: other.id } }).catch(() => {});
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "every foreign key inside a Workspace that does not cascade is one the delete handles",
  async () => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
    try {
      // `Restrict` (r) and `NO ACTION` (a) keys naming any table the Workspace's cascade reaches,
      // whether or not the naming table has a Workspace column: each would fail the cascade
      // unless handled.
      const rows = await db.$queryRaw<{ name: string }[]>`
        WITH RECURSIVE cascaded(rel) AS (
          SELECT 'workspaces'::regclass::oid
          UNION
          SELECT c.conrelid FROM pg_constraint c JOIN cascaded ON c.confrelid = cascaded.rel
          WHERE c.contype = 'f' AND c.confdeltype = 'c'
        )
        SELECT c.conname AS name FROM pg_constraint c
        WHERE c.contype = 'f' AND c.confdeltype IN ('r', 'a')
          AND c.confrelid IN (SELECT rel FROM cascaded)
        ORDER BY 1`;
      // A new one here needs its rows deleted before the Workspace in `WorkspaceDeletion`
      // (and a row in the first test's fixture), then its name added below.
      expect(rows.map(({ name }) => name)).toEqual([
        // Deleted with the messages: an Action card goes with its message.
        "action_cards_preparedByAgentId_workspaceId_fkey",
        // `NO ACTION` is checked at the end of the cascading statement, when both rows are gone.
        "conversations_coordinatorAgentId_workspaceId_fkey",
        // Memory Offer citations are deleted first.
        "memory_offer_citations_openviking_citation_fkey",
        // Messages are deleted first; Tasks go with their message.
        "messages_senderMemberId_conversationId_workspaceId_fkey",
        "tasks_creatorMemberId_conversationId_workspaceId_fkey",
        "tasks_ownerMemberId_conversationId_workspaceId_fkey",
        // Settled rows are deleted first; any other refuses the delete with CONFLICT.
        "workspace_memory_cleanup_work_workspace_id_fkey",
      ]);
    } finally {
      await db.$disconnect();
    }
  },
);

test.skipIf(!connectionString)(
  "a Task written in a channel while the Workspace is deleted lands first, and the delete still completes",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner, team, memberRowId } = fixture;
    // The writer has its own connection, as a concurrent request would.
    const writerDb = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionString! }),
    });
    const deleter = quietDeletion(db);
    try {
      let deleting: Promise<void> | undefined;
      // The Task write the way TaskBoard does it: the conversation's lock first, then the rows.
      await writerDb.$transaction(async (tx) => {
        await lockConversation(tx, team.id);
        const message = await tx.message.create({
          data: {
            workspaceId: workspace.id,
            conversationId: team.id,
            senderMemberId: memberRowId,
            sequence: 100,
            body: "a task written during the delete",
          },
        });
        deleting = deleter.delete({
          workspaceId: workspace.id,
          userId: owner.id,
          confirmSlug: workspace.slug,
        });
        await waitForLockWait(db);
        // The Task's key on the Workspace row: a delete holding that row would deadlock here.
        await tx.task.create({
          data: {
            messageId: message.id,
            conversationId: team.id,
            workspaceId: workspace.id,
            number: 100,
            title: "raced",
            creatorMemberId: memberRowId,
          },
        });
      });
      await deleting;
      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
      expect(await db.task.count({ where: { workspaceId: workspace.id } })).toBe(0);
    } finally {
      await writerDb.$disconnect();
      await fixture.cleanup();
    }
  },
);

/** Resolves once some other session is waiting on a row lock: the delete has reached a lock the
 * writer holds. Fails after five seconds. */
async function waitForLockWait(db: PrismaClient) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await db.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (row && row.waiting > 0n) return;
    await Bun.sleep(20);
  }
  throw new Error("the delete never waited on the writer's lock");
}

test.skipIf(!connectionString)(
  "cleanup Workspace memory finished for good does not keep the Workspace",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    try {
      await db.workspaceMemoryCleanupWork.create({
        data: {
          workspaceId: workspace.id,
          operationId: "del-1",
          target: "openviking_binding",
          state: "settled",
        },
      });
      await quietDeletion(db).delete({
        workspaceId: workspace.id,
        userId: owner.id,
        confirmSlug: workspace.slug,
      });
      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
      expect(
        await db.workspaceMemoryCleanupWork.count({ where: { workspaceId: workspace.id } }),
      ).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  },
);

const MEMORY_REFUSAL = {
  code: "TEMPORARILY_UNAVAILABLE",
  errorId: "workspace-memory-removal-failed",
} as const;

/** Everything a refused delete must leave as it was found. */
async function expectWorkspaceIntact(fixture: Awaited<ReturnType<typeof setup>>, messages: number) {
  const { db, workspace } = fixture;
  expect(await db.workspace.findUnique({ where: { id: workspace.id } })).not.toBeNull();
  expect(await db.message.count({ where: { workspaceId: workspace.id } })).toBe(messages);
  expect(await db.daemonApiKey.count({ where: { workspaceId: workspace.id } })).toBe(1);
}

test.skipIf(!connectionString)(
  "a Workspace with memory in OpenViking loses its account and binding before any row goes, and is then deleted",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    const messages = await db.message.count({ where: { workspaceId: workspace.id } });
    await bindMemory(db, workspace.id);
    const { openviking, memory } = openVikingMemory(db, workspace.id);
    const heard = recordingSignals();
    try {
      await new WorkspaceDeletion(db, {
        files: recordingFileRemoval().removal,
        signals: heard.signals,
        memory,
      }).delete({ workspaceId: workspace.id, userId: owner.id, confirmSlug: workspace.slug });

      // One typed delete of the bound account, with the server-held key, while every message was
      // still there: a delete that OpenViking refuses must find the Workspace whole.
      expect(openviking.requests).toEqual([
        {
          method: "DELETE",
          url: `${OPENVIKING_URL}/api/v1/admin/accounts/acct-${workspace.id}`,
          authorization: `Bearer ${OPENVIKING_ADMIN_KEY}`,
          messagesLeft: messages,
        },
      ]);
      expect(messages).toBeGreaterThan(0);
      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
      expect(await db.openVikingBinding.count({ where: { workspaceId: workspace.id } })).toBe(0);
      expect(
        await db.openVikingMappedIdentity.count({ where: { workspaceId: workspace.id } }),
      ).toBe(0);
      // The cleanup's bookkeeping goes with the Workspace it named.
      expect(
        await db.workspaceMemoryCleanupWork.count({ where: { workspaceId: workspace.id } }),
      ).toBe(0);
      expect(heard.deleted).toEqual([workspace.id]);
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "an account OpenViking no longer has counts as deleted",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    await bindMemory(db, workspace.id);
    const { openviking, memory } = openVikingMemory(db, workspace.id);
    openviking.status = 404;
    try {
      await new WorkspaceDeletion(db, {
        files: recordingFileRemoval().removal,
        signals: recordingSignals().signals,
        memory,
      }).delete({ workspaceId: workspace.id, userId: owner.id, confirmSlug: workspace.slug });

      expect(openviking.requests).toHaveLength(1);
      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
      expect(await db.openVikingBinding.count({ where: { workspaceId: workspace.id } })).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "when OpenViking cannot delete the account the Workspace stays whole, and pressing again finishes the job",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    const messages = await db.message.count({ where: { workspaceId: workspace.id } });
    await bindMemory(db, workspace.id);
    const { openviking, memory } = openVikingMemory(db, workspace.id);
    const files = recordingFileRemoval();
    const heard = recordingSignals();
    const deletion = new WorkspaceDeletion(db, {
      files: files.removal,
      signals: heard.signals,
      memory,
    });
    const press = () =>
      errorIdOf(
        deletion.delete({
          workspaceId: workspace.id,
          userId: owner.id,
          confirmSlug: workspace.slug,
        }),
      );
    try {
      openviking.status = 500;
      expect(await press()).toEqual(MEMORY_REFUSAL);
      await expectWorkspaceIntact(fixture, messages);
      expect(await db.openVikingBinding.count({ where: { workspaceId: workspace.id } })).toBe(1);
      expect(
        await db.workspaceMemoryCleanupWork.findFirst({
          where: { workspaceId: workspace.id, target: "openviking_account" },
          select: { state: true, sanitizedError: true },
        }),
      ).toEqual({ state: "retryable_failure", sanitizedError: "openviking account delete failed" });
      expect(files.calls).toEqual([]);
      expect(heard.deleted).toEqual([]);

      openviking.status = 202;
      expect(await press()).toBeUndefined();
      expect(openviking.requests).toHaveLength(2);
      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
      expect(await db.openVikingBinding.count({ where: { workspaceId: workspace.id } })).toBe(0);
      expect(heard.deleted).toEqual([workspace.id]);
    } finally {
      files.release();
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "with no OpenViking admin credential wired, as in production today, a bound Workspace is refused and stays whole",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    const messages = await db.message.count({ where: { workspaceId: workspace.id } });
    await bindMemory(db, workspace.id);
    try {
      const error = await errorIdOf(
        new WorkspaceDeletion(db, {
          files: recordingFileRemoval().removal,
          signals: recordingSignals().signals,
          memory: workspaceMemoryRemoval(db),
        }).delete({ workspaceId: workspace.id, userId: owner.id, confirmSlug: workspace.slug }),
      );

      expect(error).toEqual(MEMORY_REFUSAL);
      await expectWorkspaceIntact(fixture, messages);
      expect(await db.openVikingBinding.count({ where: { workspaceId: workspace.id } })).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a Workspace with no memory is deleted without reaching OpenViking",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    const { openviking, memory } = openVikingMemory(db, workspace.id);
    const calls: string[] = [];
    try {
      await new WorkspaceDeletion(db, {
        files: recordingFileRemoval().removal,
        signals: recordingSignals().signals,
        memory: {
          enqueueWorkspaceDeletion: (input) => {
            calls.push("enqueue");
            return memory.enqueueWorkspaceDeletion(input);
          },
          run: (input) => {
            calls.push("run");
            return memory.run(input);
          },
        },
      }).delete({ workspaceId: workspace.id, userId: owner.id, confirmSlug: workspace.slug });

      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
      expect(openviking.requests).toEqual([]);
      expect(calls).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "cleanup an earlier attempt left unfinished is finished by the delete",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    await db.workspaceMemoryCleanupWork.create({
      data: {
        workspaceId: workspace.id,
        operationId: "del-1",
        target: "openviking_account",
        state: "retryable_failure",
      },
    });
    const { remotes, memory } = unboundMemory(db);
    try {
      await new WorkspaceDeletion(db, {
        files: recordingFileRemoval().removal,
        signals: recordingSignals().signals,
        memory,
      }).delete({ workspaceId: workspace.id, userId: owner.id, confirmSlug: workspace.slug });

      expect(remotes.calls).toEqual(["openviking_account", "openviking_binding"]);
      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
      expect(
        await db.workspaceMemoryCleanupWork.count({ where: { workspaceId: workspace.id } }),
      ).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a delete pressed while another holds the cleanup is refused until that lease lapses",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    const messages = await db.message.count({ where: { workspaceId: workspace.id } });
    await bindMemory(db, workspace.id);
    const { openviking, memory } = openVikingMemory(db, workspace.id);
    const deletion = new WorkspaceDeletion(db, {
      files: recordingFileRemoval().removal,
      signals: recordingSignals().signals,
      memory,
    });
    const press = () =>
      errorIdOf(
        deletion.delete({
          workspaceId: workspace.id,
          userId: owner.id,
          confirmSlug: workspace.slug,
        }),
      );
    try {
      // The other press has the account target leased for another minute.
      for (const target of ["openviking_account", "openviking_binding"] as const)
        await db.workspaceMemoryCleanupWork.create({
          data: {
            workspaceId: workspace.id,
            operationId: WORKSPACE_MEMORY_REMOVAL_OPERATION_ID,
            target,
            state: target === "openviking_account" ? "leased" : "pending",
            leaseOwner: target === "openviking_account" ? "another-press" : null,
            leaseExpiresAt: target === "openviking_account" ? new Date(Date.now() + 60_000) : null,
          },
        });
      expect(await press()).toEqual(MEMORY_REFUSAL);
      await expectWorkspaceIntact(fixture, messages);
      expect(openviking.requests).toEqual([]);

      // It crashed: the lease lapses and the next press takes over.
      await db.workspaceMemoryCleanupWork.updateMany({
        where: { workspaceId: workspace.id, state: "leased" },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });
      expect(await press()).toBeUndefined();
      expect(openviking.requests).toHaveLength(1);
      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a binding that outlives the cleanup keeps the Workspace, and pressing again removes it",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner } = fixture;
    await bindMemory(db, workspace.id);
    // A cleanup whose binding removal does nothing: the binding is there when the rows go.
    const { memory: forgetful } = unboundMemory(db);
    const { memory } = openVikingMemory(db, workspace.id);
    const press = (removal: typeof memory) =>
      errorIdOf(
        new WorkspaceDeletion(db, {
          files: recordingFileRemoval().removal,
          signals: recordingSignals().signals,
          memory: removal,
        }).delete({ workspaceId: workspace.id, userId: owner.id, confirmSlug: workspace.slug }),
      );
    try {
      expect(await press(forgetful)).toEqual(MEMORY_REFUSAL);
      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).not.toBeNull();
      expect(await db.openVikingBinding.count({ where: { workspaceId: workspace.id } })).toBe(1);

      // The first press left its cleanup marked done; the binding is there all the same.
      expect(await press(memory)).toBeUndefined();
      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
      expect(await db.openVikingBinding.count({ where: { workspaceId: workspace.id } })).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a write that holds the Workspace row before its conversation deadlocks with the delete, which tries again and completes",
  async () => {
    const fixture = await setup();
    const { db, workspace, owner, team } = fixture;
    const writerDb = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionString! }),
    });
    try {
      let deleting: Promise<void> | undefined;
      // The opposite order: a row naming the Workspace first (its key's share lock on the
      // Workspace row), then the conversation. PostgreSQL aborts the delete, which waited first.
      await writerDb.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "workspaces" WHERE "id" = ${workspace.id}::uuid FOR KEY SHARE`;
        deleting = quietDeletion(db).delete({
          workspaceId: workspace.id,
          userId: owner.id,
          confirmSlug: workspace.slug,
        });
        await waitForLockWait(db);
        await lockConversation(tx, team.id);
      });
      await deleting;
      expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
    } finally {
      await writerDb.$disconnect();
      await fixture.cleanup();
    }
  },
);
