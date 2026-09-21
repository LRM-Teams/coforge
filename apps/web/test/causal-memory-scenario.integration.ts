import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { PrismaCausalMemoryRepository } from "../src/server/db/repositories/causal-memory.repositories.server";
import { CausalMemory } from "../src/server/causal-memory/module";
import { detectAdmittedSegments } from "../src/server/causal-memory/admission";
import type { CausalRuntimeCitation } from "../src/server/causal-memory/contract";

test("public-channel admission, isolated recall, grounded offer, and correction persist", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) return;
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const user = await db.user.create({ data: { username: `cm-scen-${suffix}` } });
  const workspaceA = await db.workspace.create({
    data: { slug: `a-${suffix}`, name: "A", members: { create: [{ userId: user.id }] } },
  });
  const workspaceB = await db.workspace.create({
    data: { slug: `b-${suffix}`, name: "B", members: { create: [{ userId: user.id }] } },
  });
  const computer = await db.computer.create({
    data: { ownerId: user.id, machineId: `cm-${suffix}` },
  });
  const helper = await db.agent.create({
    data: {
      workspaceId: workspaceA.id,
      ownerId: user.id,
      computerId: computer.id,
      name: `helper-${suffix.slice(0, 8)}`,
      displayName: "Helper",
      runtimeConfig: {},
    },
  });
  const channelA = await db.conversation.create({
    data: { workspaceId: workspaceA.id, channelName: "eng" },
  });
  await db.conversationMember.createMany({
    data: [
      { conversationId: channelA.id, workspaceId: workspaceA.id, userId: user.id },
      { conversationId: channelA.id, workspaceId: workspaceA.id, agentId: helper.id },
    ],
  });
  const memberA = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: channelA.id, userId: user.id },
  });
  const message = await db.message.create({
    data: {
      workspaceId: workspaceA.id,
      conversationId: channelA.id,
      senderMemberId: memberA.id,
      body: "MARKER-ROLLBACK skipped tests and the deploy rolled back",
      sequence: 1,
    },
  });
  await db.task.create({
    data: {
      messageId: message.id,
      conversationId: channelA.id,
      workspaceId: workspaceA.id,
      number: 1,
      title: "ship",
      status: "done",
      creatorMemberId: memberA.id,
    },
  });
  const repo = new PrismaCausalMemoryRepository(db);
  const items = new Map<string, CausalRuntimeCitation[]>();
  try {
    await repo.putTenant({
      workspaceId: workspaceA.id,
      tenantId: "tenant-a",
      enabled: true,
    });
    await repo.putTenant({ workspaceId: workspaceB.id, tenantId: "tenant-b", enabled: true });
    const detected = detectAdmittedSegments({
      conversations: [{ id: channelA.id, workspaceId: workspaceA.id, channelName: "eng" }],
      messages: [
        {
          id: message.id,
          conversationId: channelA.id,
          workspaceId: workspaceA.id,
          sequence: 1,
          createdAt: message.createdAt,
          body: message.body,
          senderKind: "human",
          senderHandle: "ada",
        },
      ],
      tasks: [
        {
          messageId: message.id,
          conversationId: channelA.id,
          workspaceId: workspaceA.id,
          status: "done",
          updatedAt: new Date(),
        },
      ],
      admittedMessageIds: new Set(),
      now: new Date(Date.now() + 60_000),
      quietAfterMs: 1,
    });
    expect(detected[0]?.ledger.kind).toBe("completed_task");

    const runtime = {
      async request<T>(
        _path: string,
        _operationId: string,
        token: string,
        body: unknown,
      ): Promise<T> {
        if (typeof body === "object" && body && "segment" in body) {
          const segment = (
            body as { segment: { admittedSegmentId: string; sourceMessageIds: string[] } }
          ).segment;
          const item: CausalRuntimeCitation = {
            citationId: `cite-${token}`,
            causalItemId: token,
            admittedSegmentId: segment.admittedSegmentId,
            sourceMessageIds: segment.sourceMessageIds,
            displayContent: "skipped tests caused the rollback",
            itemKind: "causal_edge",
          };
          items.set(token, [item]);
          return {
            protocol: "coforge.causal.runtime.v1",
            operationId: "op",
            outcome: "distilled",
            items: [item],
          } as T;
        }
        if (typeof body === "object" && body && "proposal" in body) {
          return {
            protocol: "coforge.causal.runtime.v1",
            operationId: "fix-1",
            verdict: "accept",
            superseded: true,
            auditId: "audit-1",
          } as T;
        }
        return {
          protocol: "coforge.causal.runtime.v1",
          operationId: "op",
          duplicate: false,
          items: items.get(token) ?? [],
        } as T;
      },
    };
    const memoryA = new CausalMemory(repo, runtime, async () => "tenant-a", workspaceA.id, {
      publish: async () => ({ messageId: "offer-msg" }),
    });
    const memoryB = new CausalMemory(repo, runtime, async () => "tenant-b", workspaceB.id);
    const ingested = await memoryA.ingestAdmittedSegment({
      ...detected[0]!.ledger,
      workspaceId: workspaceA.id,
      session: detected[0]!.session,
      turns: detected[0]!.turns,
    });
    expect(ingested.state).toBe("succeeded");
    const found = await memoryA.search({
      protocol: "coforge.causal.runtime.v1",
      operationId: "ask-memory",
      query: "@memory why did deploy roll back",
    });
    expect(found.items[0]?.sourceMessageIds).toEqual([message.id]);
    const isolated = await memoryB.search({
      protocol: "coforge.causal.runtime.v1",
      operationId: "ask-b",
      query: "deploy",
    });
    expect(isolated.items).toEqual([]);
    await repo.putTenant({
      workspaceId: workspaceA.id,
      tenantId: "tenant-a",
      enabled: true,
    });
    const offer = await memoryA.publishOffer({
      operationId: "offer-1",
      conversationId: channelA.id,
      targetAgentId: helper.id,
      recipientRationale: "owns the deploy task",
      citationRefs: [found.items[0]!.citationId],
      body: "the rollback followed skipped tests",
      memoryAgentId: "00000000-0000-0000-0000-000000000002",
    });
    expect(offer.messageId).toBe("offer-msg");
    expect((await repo.getOffer(workspaceA.id, "offer-1"))?.recipientRationale).toBe(
      "owns the deploy task",
    );
    const correction = await memoryA.proposeCorrection({
      operationId: "fix-1",
      causalItemId: found.items[0]!.causalItemId,
      contradictoryCitationRefs: [found.items[0]!.citationId],
      rationale: "later admitted evidence contradicts the old conclusion",
    });
    expect(correction.accepted).toBe(true);
    expect(await db.causalSupersessionResult.count({ where: { workspaceId: workspaceA.id } })).toBe(
      1,
    );
    expect(await repo.getCitation(workspaceB.id, found.items[0]!.citationId)).toBeUndefined();
  } finally {
    await db.workspace.deleteMany({ where: { id: { in: [workspaceA.id, workspaceB.id] } } });
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await db.$disconnect();
  }
});
