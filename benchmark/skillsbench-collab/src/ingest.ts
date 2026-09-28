import { readFile } from "node:fs/promises";
import { PrismaWorkspaceMemoryAdmissionStore } from "../../../apps/web/src/server/db/repositories/workspace-memory-admission.repositories.server";
import { PrismaWorkspaceMemoryProfileStore } from "../../../apps/web/src/server/db/repositories/workspace-memory-profile.repositories.server";
import { createOpenVikingTypedSessionExtract } from "../../../apps/web/src/server/openviking/typed-session-extract.server";
import {
  createAdmissionDispatcher,
  type AdmissionDispatcher,
} from "../../../apps/web/src/server/workspace-memory/dispatch";
import {
  detectAdmittedPublicChannelSegments,
  type AdmissionMessage,
} from "../../../apps/web/src/server/workspace-memory/detect-segments";
import { createOpenVikingAdmittedDeliverySink } from "../../../apps/web/src/server/workspace-memory/ov-sink.server";
import { WORKSPACE_MEMORY_QUIET_WINDOW_MS } from "../../../apps/web/src/server/workspace-memory/sweep";
import type { OpenVikingRuntimeClient } from "../../../apps/web/src/server/openviking/runtime-client.server";
import { userIdentity, type OvUsers } from "../../public-channel-memory/src/ov";
import type { EvalWorkspace } from "./workspace";
import type { SkillsBenchTask, TaskSkill } from "./types";

export function createEvalDispatcher(input: {
  workspace: EvalWorkspace;
  runtime: OpenVikingRuntimeClient;
  accountId: string;
  users: OvUsers;
}): AdmissionDispatcher {
  const admission = new PrismaWorkspaceMemoryAdmissionStore(input.workspace.db);
  const sessions = createOpenVikingTypedSessionExtract({
    runtime: input.runtime,
    authorizedOwner: "sb-sink",
    sinkIdentity: userIdentity(input.accountId, input.users.adminUserId, input.users.adminKey, "admin"),
  });
  return createAdmissionDispatcher({
    admission,
    sinks: {
      openviking: createOpenVikingAdmittedDeliverySink({
        sessions,
        owner: "sb-sink",
      }),
    },
  });
}

async function admittedMessageIds(workspace: EvalWorkspace): Promise<Set<string>> {
  const rows = await workspace.db.admittedSegmentSourceMessage.findMany({
    where: { workspaceId: workspace.workspaceId },
    select: { messageId: true },
  });
  return new Set(rows.map((row) => row.messageId));
}

async function loadAdmissionMessages(workspace: EvalWorkspace): Promise<AdmissionMessage[]> {
  const rows = await workspace.db.message.findMany({
    where: { conversationId: workspace.channelId },
    include: { sender: { include: { user: true, agent: true } } },
    orderBy: { sequence: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversationId,
    workspaceId: row.workspaceId,
    sequence: row.sequence,
    createdAt: row.createdAt,
    body: row.body,
    senderKind: row.sender?.agentId ? "agent" : "human",
    senderHandle:
      row.sender?.user?.displayName ??
      row.sender?.agent?.name ??
      row.sender?.user?.username ??
      "unknown",
  }));
}

/**
 * Publishes one skill into team memory through the product's own admission
 * path: the skill's files are posted as backdated channel messages from the
 * human member, the quiet window closes the segment, and the Admitted
 * PublicChannel Segment sinks into OpenViking. The skill then reaches the
 * Task Agent only through the Memory Agent's retrieval — never from the host.
 */
async function ingestSkill(input: {
  workspace: EvalWorkspace;
  task: SkillsBenchTask;
  skill: TaskSkill;
  skillIndex: number;
  dispatcher: AdmissionDispatcher;
  nextSequence: number;
}): Promise<{ nextSequence: number; ingested: number }> {
  const member = await input.workspace.db.conversationMember.findFirst({
    where: { conversationId: input.workspace.channelId, userId: input.workspace.evalUserId },
  });
  if (!member) throw new Error("eval user is not a channel member");
  const baseAt = new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + input.skillIndex * 86_400_000);
  let sequence = input.nextSequence;
  const messageIds: string[] = [];
  for (const [index, file] of input.skill.files.entries()) {
    const content = await readFile(file.absPath, "utf8").catch(() => null);
    if (content === null) continue; // binary skill payloads ride with the env files instead
    const body = `[skill: ${input.skill.name} — file: ${file.relPath}]\n${content}`;
    const created = await input.workspace.db.message.create({
      data: {
        conversationId: input.workspace.channelId,
        workspaceId: input.workspace.workspaceId,
        senderMemberId: member.id,
        body,
        sequence,
        createdAt: new Date(baseAt.getTime() + index * 1_000),
      },
    });
    messageIds.push(created.id);
    sequence += 1;
  }
  if (messageIds.length === 0) return { nextSequence: sequence, ingested: 0 };

  const detected = detectAdmittedPublicChannelSegments({
    conversations: [
      {
        id: input.workspace.channelId,
        workspaceId: input.workspace.workspaceId,
        channelName: input.task.name.toLowerCase(),
      },
    ],
    messages: await loadAdmissionMessages(input.workspace),
    tasks: [],
    admittedMessageIds: await admittedMessageIds(input.workspace),
    now: new Date(),
    quietAfterMs: WORKSPACE_MEMORY_QUIET_WINDOW_MS,
  });
  if (detected.length === 0) throw new Error(`quiet window not detected for skill ${input.skill.name}`);
  let ingested = 0;
  for (const segment of detected) {
    let outcome = await input.dispatcher.dispatch({ profile: await profileFor(input.workspace), detected: segment });
    for (let attempt = 1; outcome.outcome === "retryable_failure" && attempt <= 2; attempt += 1) {
      console.log(`ingest skill ${input.skill.name} retry ${attempt}`);
      outcome = await input.dispatcher.dispatch({ profile: await profileFor(input.workspace), detected: segment });
    }
    if (outcome.outcome !== "dispatched" && outcome.outcome !== "replayed") {
      const detail = outcome.outcome === "skipped" ? outcome.reason : outcome.sanitizedError;
      throw new Error(`ingest skill ${input.skill.name} ${outcome.outcome}: ${detail}`);
    }
    ingested += 1;
  }
  // The skill must live in team memory only. The channel rows were just the
  // admission vehicle; leaving them readable would let the Task Agent bypass
  // the Memory Agent's retrieval entirely (observed in the first smoke).
  await input.workspace.db.message.deleteMany({ where: { id: { in: messageIds } } });
  return { nextSequence: sequence, ingested };
}

async function profileFor(workspace: EvalWorkspace) {
  const profiles = new PrismaWorkspaceMemoryProfileStore(workspace.db);
  const profile = await profiles.get(workspace.workspaceId);
  if (!profile) throw new Error("workspace memory profile missing");
  return profile;
}

export async function ingestTaskSkills(input: {
  workspace: EvalWorkspace;
  task: SkillsBenchTask;
  dispatcher: AdmissionDispatcher;
}): Promise<number> {
  let sequence = 1;
  let ingested = 0;
  for (const [skillIndex, skill] of input.task.skills.entries()) {
    console.log(`ingest skill ${skill.name} (${skill.files.length} files)`);
    const result = await ingestSkill({
      workspace: input.workspace,
      task: input.task,
      skill,
      skillIndex,
      dispatcher: input.dispatcher,
      nextSequence: sequence,
    });
    sequence = result.nextSequence;
    ingested += result.ingested;
  }
  return ingested;
}
