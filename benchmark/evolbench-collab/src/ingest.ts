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
import type { OpenVikingRuntimeClient } from "../../../apps/web/src/server/openviking/runtime-client.server";
import { userIdentity, type OvUsers } from "../../public-channel-memory/src/ov";
import type { EvalWorkspace } from "./workspace";

export function createEvalDispatcher(input: {
  workspace: EvalWorkspace;
  runtime: OpenVikingRuntimeClient;
  accountId: string;
  users: OvUsers;
}): AdmissionDispatcher {
  const admission = new PrismaWorkspaceMemoryAdmissionStore(input.workspace.db);
  const sessions = createOpenVikingTypedSessionExtract({
    runtime: input.runtime,
    authorizedOwner: "evol-sink",
    sinkIdentity: userIdentity(input.accountId, input.users.adminUserId, input.users.adminKey, "admin"),
  });
  return createAdmissionDispatcher({
    admission,
    sinks: {
      openviking: createOpenVikingAdmittedDeliverySink({
        sessions,
        owner: "evol-sink",
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
 * The warm arm's evidence drain: everything the episode wrote to the channel
 * (the prompt and both agents' messages) is admitted into OpenViking through
 * the product's own segment path, so the next episode's @memory recall can
 * find it. The real quiet window is 15 minutes; the drain deliberately uses a
 * short one because the harness drains only after the episode has settled, and
 * the admission store makes concurrent server sweeps idempotent.
 */
export async function drainEpisodeToMemory(input: {
  workspace: EvalWorkspace;
  dispatcher: AdmissionDispatcher;
  channelName: string;
}): Promise<number> {
  const profiles = new PrismaWorkspaceMemoryProfileStore(input.workspace.db);
  const profile = await profiles.get(input.workspace.workspaceId);
  if (!profile) throw new Error("workspace memory profile missing");
  const detected = detectAdmittedPublicChannelSegments({
    conversations: [
      {
        id: input.workspace.channelId,
        workspaceId: input.workspace.workspaceId,
        channelName: input.channelName,
      },
    ],
    messages: await loadAdmissionMessages(input.workspace),
    tasks: [],
    admittedMessageIds: await admittedMessageIds(input.workspace),
    now: new Date(),
    quietAfterMs: 5_000,
  });
  let drained = 0;
  for (const segment of detected) {
    let outcome = await input.dispatcher.dispatch({ profile, detected: segment });
    for (let attempt = 1; outcome.outcome === "retryable_failure" && attempt <= 2; attempt += 1) {
      console.log(`drain retry ${attempt}`);
      outcome = await input.dispatcher.dispatch({ profile, detected: segment });
    }
    if (outcome.outcome !== "dispatched" && outcome.outcome !== "replayed") {
      const detail = outcome.outcome === "skipped" ? outcome.reason : outcome.sanitizedError;
      throw new Error(`drain ${outcome.outcome}: ${detail}`);
    }
    drained += 1;
  }
  return drained;
}
