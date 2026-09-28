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
import { insertHistoricalSession, type EvalWorkspace } from "./workspace";
import type { LongMemEvalSample } from "./types";

export function createEvalDispatcher(input: {
  workspace: EvalWorkspace;
  runtime: OpenVikingRuntimeClient;
  accountId: string;
  users: OvUsers;
}): AdmissionDispatcher {
  const admission = new PrismaWorkspaceMemoryAdmissionStore(input.workspace.db);
  const sessions = createOpenVikingTypedSessionExtract({
    runtime: input.runtime,
    authorizedOwner: "lme-sink",
    sinkIdentity: userIdentity(input.accountId, input.users.adminUserId, input.users.adminKey, "admin"),
  });
  return createAdmissionDispatcher({
    admission,
    sinks: {
      openviking: createOpenVikingAdmittedDeliverySink({
        sessions,
        owner: "lme-sink",
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

/** Ingests one haystack session at a time through the product's own admission
 * path: backdated channel rows → quiet-window segment detection → Admitted
 * PublicChannel Segment → OpenViking typed-session sink. */
export async function ingestSample(input: {
  workspace: EvalWorkspace;
  sample: LongMemEvalSample;
  dispatcher: AdmissionDispatcher;
  fromSession?: number;
}): Promise<number> {
  const profiles = new PrismaWorkspaceMemoryProfileStore(input.workspace.db);
  const profile = await profiles.get(input.workspace.workspaceId);
  if (!profile) throw new Error("workspace memory profile missing");
  const fromSession = input.fromSession ?? 1;
  let sequence = 1;
  let ingested = 0;
  for (const session of input.sample.sessions) {
    if (session.sessionIndex < fromSession) continue;
    console.log(`ingest session ${session.sessionIndex} (${session.sessionKey})`);
    const inserted = await insertHistoricalSession({
      db: input.workspace.db,
      workspace: input.workspace,
      session,
      nextSequence: sequence,
    });
    sequence = inserted.nextSequence;
    const detected = detectAdmittedPublicChannelSegments({
      conversations: [
        {
          id: input.workspace.channelId,
          workspaceId: input.workspace.workspaceId,
          channelName: `lme-s${input.sample.sampleIndex}`,
        },
      ],
      messages: await loadAdmissionMessages(input.workspace),
      tasks: [],
      admittedMessageIds: await admittedMessageIds(input.workspace),
      now: new Date(),
      quietAfterMs: WORKSPACE_MEMORY_QUIET_WINDOW_MS,
    });
    if (detected.length === 0) throw new Error(`quiet window not detected for session ${session.sessionIndex}`);
    for (const segment of detected) {
      let outcome = await input.dispatcher.dispatch({ profile, detected: segment });
      for (let attempt = 1; outcome.outcome === "retryable_failure" && attempt <= 2; attempt += 1) {
        console.log(`ingest session ${session.sessionIndex} retry ${attempt}`);
        outcome = await input.dispatcher.dispatch({ profile, detected: segment });
      }
      if (outcome.outcome !== "dispatched" && outcome.outcome !== "replayed") {
        const detail = outcome.outcome === "skipped" ? outcome.reason : outcome.sanitizedError;
        throw new Error(`ingest session ${session.sessionIndex} ${outcome.outcome}: ${detail}`);
      }
      ingested += 1;
    }
  }
  return ingested;
}
