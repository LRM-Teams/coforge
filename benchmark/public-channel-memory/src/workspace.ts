import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../../apps/web/generated/client";
import { PrismaCausalMemoryRepository } from "../../../apps/web/src/server/db/repositories/causal-memory.repositories.server";
import { PrismaOpenVikingBindingStore } from "../../../apps/web/src/server/db/repositories/openviking-binding.repositories.server";
import { PrismaWorkspaceMemoryProfileStore } from "../../../apps/web/src/server/db/repositories/workspace-memory-profile.repositories.server";
import {
  applyWorkspaceMemoryCommand,
  createDefaultWorkspaceMemoryProfile,
} from "../../../apps/web/src/server/workspace-memory/profile";
import { saveProfileTransition } from "../../../apps/web/src/server/workspace-memory/stores";
import { turnBody } from "./locomo-time";
import type { EvalArm } from "./types";
import type { LocomoSample } from "./types";

export type EvalWorkspace = {
  db: PrismaClient;
  workspaceId: string;
  channelId: string;
  evalUserId: string;
  memoryAgentId: string;
  recipientAgentId: string;
  userIds: string[];
  computerId: string;
};

function slugFor(arm: EvalArm, sampleId: string): string {
  return `pcm-${arm.replaceAll("_", "-")}-${sampleId}-${crypto.randomUUID().slice(0, 8)}`.toLowerCase();
}

export function connectEvalDb(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

export async function provisionEvalWorkspace(input: {
  db: PrismaClient;
  arm: EvalArm;
  sample: LocomoSample;
  ovAccountId: string;
}): Promise<EvalWorkspace> {
  const suffix = crypto.randomUUID();
  const owner = await input.db.user.create({
    data: { username: `pcm-eval-${suffix}`, displayName: "eval" },
  });
  const speakerA = await input.db.user.create({
    data: { username: `pcm-a-${suffix}`, displayName: input.sample.speakerA },
  });
  const speakerB = await input.db.user.create({
    data: { username: `pcm-b-${suffix}`, displayName: input.sample.speakerB },
  });
  const workspace = await input.db.workspace.create({
    data: {
      slug: slugFor(input.arm, input.sample.sampleId),
      name: `pcm ${input.arm} ${input.sample.sampleId}`,
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: speakerA.id, role: "member" },
          { userId: speakerB.id, role: "member" },
        ],
      },
    },
  });
  const computer = await input.db.computer.create({
    data: { ownerId: owner.id, machineId: crypto.randomUUID(), name: "pcm-eval" },
  });
  const memoryAgent = await input.db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: owner.id,
      computerId: computer.id,
      name: "memory",
      displayName: "Memory",
      runtimeConfig: {},
    },
  });
  const recipient = await input.db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: owner.id,
      computerId: computer.id,
      name: "task",
      displayName: "Task",
      runtimeConfig: {},
    },
  });
  const channel = await input.db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: input.sample.sampleId.toLowerCase(),
      description: "public-channel memory eval",
    },
  });
  const humans = [owner, speakerA, speakerB];
  for (const user of humans) {
    await input.db.conversationMember.create({
      data: { conversationId: channel.id, workspaceId: workspace.id, userId: user.id },
    });
  }
  for (const agent of [memoryAgent, recipient]) {
    await input.db.conversationMember.create({
      data: { conversationId: channel.id, workspaceId: workspace.id, agentId: agent.id },
    });
  }

  const firstAt = input.sample.sessions[0]?.occurredAt ?? new Date("2022-01-01T00:00:00.000Z");
  const activationAt = new Date(firstAt.getTime() - 1_000);
  const profiles = new PrismaWorkspaceMemoryProfileStore(input.db);
  const seed = createDefaultWorkspaceMemoryProfile(workspace.id);
  const selected = applyWorkspaceMemoryCommand(
    seed,
    { type: "select_desired", desired: input.arm, at: activationAt },
    { prototypeEnabled: true },
  );
  if (!selected.ok) throw new Error(selected.failure.code);
  const ready = applyWorkspaceMemoryCommand(selected.profile, {
    type: "observe_ready",
    generation: selected.profile.generation,
  });
  if (!ready.ok) throw new Error(ready.failure.code);
  if ((await saveProfileTransition(profiles, seed, ready.profile)) !== "saved") {
    throw new Error("profile transition was not saved");
  }

  const bindings = new PrismaOpenVikingBindingStore(input.db);
  if (
    (await bindings.compareAndSet({
      workspaceId: workspace.id,
      expectedGeneration: 0,
      binding: {
        workspaceId: workspace.id,
        accountId: input.ovAccountId,
        serviceIdentityId: `svc-${input.ovAccountId}`,
        credentialRef: `secret:ov-${input.ovAccountId}`,
        generation: ready.profile.generation,
      },
    })) !== "saved"
  ) {
    throw new Error("openviking binding was not saved");
  }

  const causal = new PrismaCausalMemoryRepository(input.db);
  await causal.putTenant({
    workspaceId: workspace.id,
    tenantId: workspace.id,
    enabled: true,
    memoryAgentId: memoryAgent.id,
  });

  return {
    db: input.db,
    workspaceId: workspace.id,
    channelId: channel.id,
    evalUserId: owner.id,
    memoryAgentId: memoryAgent.id,
    recipientAgentId: recipient.id,
    userIds: [owner.id, speakerA.id, speakerB.id],
    computerId: computer.id,
  };
}

export async function insertHistoricalSession(input: {
  db: PrismaClient;
  workspace: EvalWorkspace;
  sample: LocomoSample;
  session: LocomoSample["sessions"][number];
  nextSequence: number;
}): Promise<{ nextSequence: number; messageIds: string[] }> {
  const members = await input.db.conversationMember.findMany({
    where: { conversationId: input.workspace.channelId, userId: { not: null } },
    include: { user: true },
  });
  const byHandle = new Map(
    members.flatMap((member) => {
      const handle = member.user?.displayName ?? member.user?.username;
      return handle && member.userId ? [[handle, member] as const] : [];
    }),
  );
  const messageIds: string[] = [];
  let sequence = input.nextSequence;
  for (const [index, turn] of input.session.turns.entries()) {
    const member = byHandle.get(turn.speaker) ?? members.find((row) => row.userId !== input.workspace.evalUserId);
    if (!member) throw new Error(`no conversation member for speaker ${turn.speaker}`);
    const created = await input.db.message.create({
      data: {
        conversationId: input.workspace.channelId,
        workspaceId: input.workspace.workspaceId,
        senderMemberId: member.id,
        body: `${turn.speaker}: ${turnBody(turn)}`,
        sequence,
        createdAt: new Date(input.session.occurredAt.getTime() + index * 1_000),
      },
    });
    messageIds.push(created.id);
    sequence += 1;
  }
  return { nextSequence: sequence, messageIds };
}

export async function resetMemoryAgentSession(workspace: EvalWorkspace): Promise<void> {
  await workspace.db.agent.update({
    where: { id: workspace.memoryAgentId },
    data: { currentSessionId: null, runtimeSession: null },
  });
}

export async function destroyEvalWorkspace(workspace: EvalWorkspace): Promise<void> {
  await workspace.db.workspace.delete({ where: { id: workspace.workspaceId } }).catch(() => undefined);
  await workspace.db.computer.delete({ where: { id: workspace.computerId } }).catch(() => undefined);
  if (workspace.userIds.length > 0) {
    await workspace.db.user.deleteMany({ where: { id: { in: workspace.userIds } } }).catch(() => undefined);
  }
}
