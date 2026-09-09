import { decodeAgentActivity, encodeAgentActivity } from "@coforge/protocol";

import { getDatabaseClient } from "../db/client.server";
import { PrismaAgentRepository } from "../db/repositories/agent.repositories.server";
import {
  AgentActivityRepository,
  type TrustedAgentActivity,
} from "../db/repositories/agent-activity.repositories.server";
import {
  activityKindForObservation,
  getAgentDisplay,
  type AgentDisplay,
} from "./agent-display.server";
import { createCentrifugoServerApi } from "../centrifugo/server-api.server";
import { agentStatusChannel } from "../../features/agents/agent-status-realtime";
import type { AgentActivityKind } from "@coforge/protocol/agent-display";

type AgentActivityPublicationDependencies = {
  proxySecret: string | undefined;
  agentBelongsToWorkspace(workspaceId: string, agentId: string): Promise<boolean>;
  agentBelongsToComputer(
    workspaceId: string,
    agentId: string,
    computerId: string,
  ): Promise<boolean>;
  computerBelongsToWorkspace(workspaceId: string, computerId: string): Promise<boolean>;
  observe(activity: TrustedAgentActivity): Promise<void>;
  currentRuntimeFence?(
    workspaceId: string,
    computerId: string,
    agentId: string,
  ): Promise<{ daemonInstanceId: string; launchId: string } | undefined>;
  display?: Pick<AgentDisplay, "observeActivity">;
  publishJson?(channel: string, data: unknown): Promise<void>;
};

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const unauthorized = () =>
  Response.json({
    error: { code: 403, message: "activity publication is not authorized" },
  });

/** Validate one client-originated Centrifugo publication before it reaches the Activity channel. */
export async function handleAgentActivityPublication(
  request: Request,
  dependencies: AgentActivityPublicationDependencies,
): Promise<Response> {
  if (
    !dependencies.proxySecret ||
    request.headers.get("x-coforge-centrifugo-proxy-secret") !== dependencies.proxySecret
  )
    return unauthorized();

  try {
    const body = (await request.json()) as {
      user?: unknown;
      channel?: unknown;
      b64data?: unknown;
      meta?: { workspace_id?: unknown; computer_id?: unknown };
    };
    const workspaceId = body.meta?.workspace_id;
    const computerId = body.meta?.computer_id;
    if (
      typeof body.user !== "string" ||
      typeof workspaceId !== "string" ||
      typeof computerId !== "string" ||
      typeof body.b64data !== "string" ||
      body.channel !== `activity:${workspaceId}`
    )
      return unauthorized();

    const payload = Uint8Array.from(atob(body.b64data), (character) => character.charCodeAt(0));
    const activity = decodeAgentActivity(payload);
    if (
      activity.protocolMajor !== 1 ||
      activity.workspaceId !== workspaceId ||
      !(await dependencies.computerBelongsToWorkspace(workspaceId, computerId)) ||
      !(await dependencies.agentBelongsToWorkspace(workspaceId, activity.agentId)) ||
      !(await dependencies.agentBelongsToComputer(workspaceId, activity.agentId, computerId))
    )
      return unauthorized();

    const mappedKind: AgentActivityKind | undefined =
      activity.detailKind === "stopped" ? "offline" : activityKindForObservation(activity);
    const cloudActivity = { ...activity, activityKind: mappedKind };
    const history = dependencies.observe({ ...cloudActivity, computerId }).catch(() => {});
    const reduce = (async () => {
      if (!dependencies.currentRuntimeFence || !dependencies.display) return;
      const fence = await dependencies.currentRuntimeFence(
        workspaceId,
        computerId,
        activity.agentId,
      );
      if (!fence) return;
      const snapshot = await dependencies.display.observeActivity(
        { ...cloudActivity, computerId },
        fence,
      );
      if (snapshot && dependencies.publishJson)
        await dependencies.publishJson(agentStatusChannel(workspaceId), {
          type: "agent:display",
          ...snapshot,
        });
    })().catch(() => {});
    await Promise.all([history, reduce]);
    return Response.json({
      result: {
        skip_history: true,
        b64data: bytesToBase64(encodeAgentActivity(cloudActivity)),
      },
    });
  } catch {
    return unauthorized();
  }
}

export function createAgentActivityPublicationHandler() {
  return async (request: Request) => {
    const db = getDatabaseClient();
    if (!db) return unauthorized();
    const agents = new PrismaAgentRepository(db);
    const activity = new AgentActivityRepository(db);
    let display: AgentDisplay | undefined;
    let centrifugo: ReturnType<typeof createCentrifugoServerApi> | undefined;
    try {
      display = getAgentDisplay();
      centrifugo = createCentrifugoServerApi();
    } catch {
      // History acceptance remains independent when the optional display path is unavailable.
    }
    return handleAgentActivityPublication(request, {
      proxySecret: process.env.COFORGE_CENTRIFUGO_PROXY_SECRET,
      agentBelongsToWorkspace: async (workspaceId, agentId) =>
        (await agents.getById(agentId))?.workspaceId === workspaceId,
      agentBelongsToComputer: async (workspaceId, agentId, computerId) =>
        (await agents.getById(agentId))?.workspaceId === workspaceId &&
        (await agents.getById(agentId))?.computerId === computerId,
      computerBelongsToWorkspace: async (workspaceId, computerId) =>
        Boolean(
          await db.workspaceComputer.findUnique({
            where: { workspaceId_computerId: { workspaceId, computerId } },
            select: { id: true },
          }),
        ),
      observe: (observation) => activity.record(observation),
      currentRuntimeFence: async (workspaceId, computerId, agentId) => {
        const agent = await db.agent.findUnique({
          where: { id: agentId },
          select: { workspaceId: true, computerId: true, runtimeSession: true },
        });
        if (agent?.workspaceId === workspaceId && agent.computerId === computerId) {
          const session = agent.runtimeSession;
          if (session && typeof session === "object" && !Array.isArray(session)) {
            const daemonInstanceId = Reflect.get(session, "daemonInstanceId");
            const launchId = Reflect.get(session, "launchId");
            const sessionComputerId = Reflect.get(session, "computerId");
            if (
              sessionComputerId === computerId &&
              typeof daemonInstanceId === "string" &&
              typeof launchId === "string" &&
              daemonInstanceId &&
              launchId
            )
              return { daemonInstanceId, launchId };
          }
        }
        return undefined;
      },
      display,
      publishJson: centrifugo
        ? (channel, data) => centrifugo.publishJson(channel, data)
        : undefined,
    });
  };
}
