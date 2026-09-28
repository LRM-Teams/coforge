import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../../apps/web/generated/client";
import { PrismaOpenVikingBindingStore } from "../../../apps/web/src/server/db/repositories/openviking-binding.repositories.server";
import { PrismaWorkspaceMemoryProfileStore } from "../../../apps/web/src/server/db/repositories/workspace-memory-profile.repositories.server";
import {
  applyWorkspaceMemoryCommand,
  createDefaultWorkspaceMemoryProfile,
} from "../../../apps/web/src/server/workspace-memory/profile";
import { saveProfileTransition } from "../../../apps/web/src/server/workspace-memory/stores";
import type { EvalArm } from "./types";
import type { LongMemEvalSample } from "./types";

export type EvalWorkspace = {
  db: PrismaClient;
  workspaceId: string;
  slug: string;
  channelId: string;
  evalUserId: string;
  memoryAgentId: string;
  taskAgentId: string;
  userIds: string[];
  computerId: string;
  machineId: string;
};

/** The Task Agent's standing role: it consumes the Memory Agent's cited offer
 * and answers the human. It must not invent facts beyond the offer and the
 * visible channel context. */
export const TASK_AGENT_DESCRIPTION = [
  "You are the Task Agent of this channel's team.",
  "The human member asks the Memory Agent (@memory) questions about past conversations.",
  "When the Memory Agent publishes a Memory Offer addressed to you, read it together with the",
  "recent channel context, then answer the human's question in the channel with a short, direct",
  "reply grounded ONLY in the offer's cited memories and the visible channel history.",
  "If the cited memories do not contain the answer, say what is missing instead of guessing.",
].join(" ");

function slugFor(arm: EvalArm, sample: LongMemEvalSample): string {
  return `lme-collab-${arm}-${sample.sampleIndex}-${crypto.randomUUID().slice(0, 8)}`.toLowerCase();
}

export function connectEvalDb(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

export async function provisionEvalWorkspace(input: {
  db: PrismaClient;
  arm: EvalArm;
  sample: LongMemEvalSample;
  ovAccountId: string;
}): Promise<EvalWorkspace> {
  const suffix = crypto.randomUUID();
  const owner = await input.db.user.create({
    data: { username: `lme-eval-${suffix}`, displayName: "user" },
  });
  const workspace = await input.db.workspace.create({
    data: {
      slug: slugFor(input.arm, input.sample),
      name: `lme collab ${input.arm} ${input.sample.sampleId}`,
      members: {
        create: [{ userId: owner.id, role: "owner" }],
      },
    },
  });
  const machineId = crypto.randomUUID();
  const computer = await input.db.computer.create({
    data: { ownerId: owner.id, machineId, name: "lme-eval" },
  });
  // The Memory Agent keeps a neutral model here; the eval daemon replaces both
  // agents' runtimeConfig with the encrypted provider credential at start time.
  const memoryAgent = await input.db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: owner.id,
      name: "memory",
      displayName: "Memory",
      computerId: null,
      runtimeConfig: {},
    },
  });
  const taskAgent = await input.db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: owner.id,
      name: "task",
      displayName: "Task",
      description: TASK_AGENT_DESCRIPTION,
      computerId: null,
      runtimeConfig: {},
    },
  });
  const channel = await input.db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `lme-s${input.sample.sampleIndex}`,
      description: "longmemeval group-chat collaboration eval",
    },
  });
  await input.db.conversationMember.create({
    data: { conversationId: channel.id, workspaceId: workspace.id, userId: owner.id },
  });
  for (const agent of [memoryAgent, taskAgent]) {
    await input.db.conversationMember.create({
      data: { conversationId: channel.id, workspaceId: workspace.id, agentId: agent.id },
    });
  }

  const firstAt = input.sample.sessions[0]?.occurredAt ?? new Date("2023-01-01T00:00:00.000Z");
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

  // OpenViking-only designation (ADR 0062): the Memory Agent route authorizes
  // through a memory_agent mapped identity, mirroring mapMemoryActor().
  await input.db.openVikingMappedIdentity.create({
    data: {
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
      actorKind: "memory_agent",
      actorSubject: memoryAgent.id,
      openvikingUserId: `memory-agent:${memoryAgent.id}`,
      role: "user",
      access: "readonly_shared",
      generation: ready.profile.generation,
    },
  });

  return {
    db: input.db,
    workspaceId: workspace.id,
    slug: workspace.slug,
    channelId: channel.id,
    evalUserId: owner.id,
    memoryAgentId: memoryAgent.id,
    taskAgentId: taskAgent.id,
    userIds: [owner.id],
    computerId: computer.id,
    machineId,
  };
}

export async function insertHistoricalSession(input: {
  db: PrismaClient;
  workspace: EvalWorkspace;
  session: LongMemEvalSample["sessions"][number];
  nextSequence: number;
}): Promise<{ nextSequence: number; messageIds: string[] }> {
  const members = await input.db.conversationMember.findMany({
    where: { conversationId: input.workspace.channelId },
    orderBy: { id: "asc" },
    include: { user: true, agent: true },
  });
  const human = members.find((member) => member.userId !== null);
  const taskAgent = members.find((member) => member.agentId === input.workspace.taskAgentId);
  if (!human) throw new Error("no human member in channel");
  if (!taskAgent) throw new Error("task agent is not a channel member");
  const messageIds: string[] = [];
  let sequence = input.nextSequence;
  for (const [index, turn] of input.session.turns.entries()) {
    // Assistant turns are authored by the Task Agent member: the dataset's
    // assistant becomes this group chat's answering agent, which is exactly
    // whose past words single-session-assistant questions probe.
    const member = turn.role === "assistant" ? taskAgent : human;
    const created = await input.db.message.create({
      data: {
        conversationId: input.workspace.channelId,
        workspaceId: input.workspace.workspaceId,
        senderMemberId: member.id,
        body: turn.text,
        sequence,
        createdAt: new Date(input.session.occurredAt.getTime() + index * 1_000),
      },
    });
    messageIds.push(created.id);
    sequence += 1;
  }
  return { nextSequence: sequence, messageIds };
}

export async function resetAgentSessions(workspace: EvalWorkspace): Promise<void> {
  // Only drop the Session association. Writing `runtimeSession: null` becomes JSON null, which
  // makes AgentControl's JSONB CAS (`Prisma.DbNull`) miss on every attempt.
  await workspace.db.agent.update({
    where: { id: workspace.memoryAgentId },
    data: { currentSessionId: null },
  });
  await workspace.db.agent.update({
    where: { id: workspace.taskAgentId },
    data: { currentSessionId: null },
  });
}

export async function destroyEvalWorkspace(workspace: EvalWorkspace): Promise<void> {
  await workspace.db.workspace.delete({ where: { id: workspace.workspaceId } }).catch(() => undefined);
  await workspace.db.computer.delete({ where: { id: workspace.computerId } }).catch(() => undefined);
  if (workspace.userIds.length > 0) {
    await workspace.db.user.deleteMany({ where: { id: { in: workspace.userIds } } }).catch(() => undefined);
  }
}
