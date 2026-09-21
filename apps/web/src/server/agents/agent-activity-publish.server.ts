import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import { decodeAgentActivity, encodeAgentActivity } from "@lrm/coforge-sdk/internal";

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
import { ensureAgentActivitySweep } from "./agent-activity-sweep.server";
import { createCentrifugoServerApi } from "../centrifugo/server-api.server";
import {
  agentStatusChannel,
  agentStatusChannelForAgent,
} from "../../features/agents/agent-status-realtime";
import {
  agentActivityChannel,
  agentActivityChannelForAgent,
  isRunStartMarker,
} from "../../features/agents/agent-activity";
import { AGENT_VISIBILITY } from "../../features/agents/agent-visibility";
import type { AgentActivityKind } from "@lrm/coforge-sdk/internal";

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
  /** ADR 0059: the Agent's current visibility, read fresh (no cache) for every publication —
   * never assumed from a prior request. Omitted (dependency not supplied, or its lookup found
   * nothing to route by) keeps this frame on the shared channels, same as before this ADR
   * existed; a recognized non-`"public"` value routes it to the per-Agent channels instead, and
   * an unrecognized persisted value fails closed the same way `canSeeAgent`/`visibleAgentWhere`
   * treat it. */
  agentVisibility?(workspaceId: string, agentId: string): Promise<string | undefined>;
  /** Raw binary republish (Centrifugo server API `publish`, not the JSON `publishJson`) used only
   * to re-route a private Agent's frame to its own per-Agent activity channel — the public path
   * still lets Centrifugo do the actual shared-channel publish via the returned `result.b64data`. */
  publish?(channel: string, data: Uint8Array): Promise<void>;
};

function bytesToBase64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64");
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
      body.channel !== agentActivityChannel(workspaceId)
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
      activity.detailKind === AGENT_ACTIVITY_DETAIL_KIND.STOPPED
        ? "offline"
        : activityKindForObservation(activity);
    const cloudActivity = { ...activity, activityKind: mappedKind };
    // A busy heartbeat, a content-free runtime_progress frame, a content-free run-start
    // marker (thinking_started/model_response_started with no entries — see
    // isRunStartMarker), or a reply to the server's own liveness probe only renews the
    // display lease; none of them carry anything worth keeping in history. ADR 0021
    // (amended): tool_end, thinking_end and compaction_finished are ordinary status
    // observations now and are persisted like any other Activity — the log records tool
    // and thinking completion, only content-free progress pings stay lease-only.
    const isFillerActivity =
      activity.isHeartbeat === true ||
      activity.detailKind === AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_PROGRESS ||
      isRunStartMarker(activity.detailKind, activity.entries) ||
      Boolean(activity.probeId);
    // ADR 0059: read fresh, no cache. Undefined (dependency omitted, or the Agent's row carries
    // no recognized value) reads as "public" — the routing this file performed before visibility
    // existed. Anything else, including an unrecognized persisted value, fails closed to private
    // the same way `canSeeAgent`/`visibleAgentWhere` do.
    const visibility = await dependencies.agentVisibility?.(workspaceId, activity.agentId);
    const isPrivate = visibility !== undefined && visibility !== AGENT_VISIBILITY.PUBLIC;
    const statusChannel = isPrivate
      ? agentStatusChannelForAgent(workspaceId, activity.agentId)
      : agentStatusChannel(workspaceId);
    const history = isFillerActivity
      ? Promise.resolve()
      : dependencies.observe({ ...cloudActivity, computerId }).catch(() => {});
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
        await dependencies.publishJson(statusChannel, {
          type: "agent:display",
          ...snapshot,
        });
    })().catch(() => {});
    await Promise.all([history, reduce]);

    if (isPrivate) {
      // The frame still reaches its own audience — just not the shared broadcast. Best-effort,
      // like every other Activity delivery in this file: a failed re-publish here does not turn
      // into a retry or a spool, it only means this one frame is missed live (history already
      // recorded it above).
      await dependencies
        .publish?.(
          agentActivityChannelForAgent(workspaceId, activity.agentId),
          encodeAgentActivity(cloudActivity),
        )
        .catch(() => {});
      // Centrifugal's publish proxy treats an `error` result as a plain denial that leaves the
      // connection open (https://centrifugal.dev/docs/server/proxy#publish-proxy) — the least
      // noisy refusal available, unlike a `disconnect` result, which would drop the Daemon's
      // entire WSS connection over one re-routed Agent.
      return Response.json({
        error: { code: 1000, message: "activity re-routed to a private channel" },
      });
    }

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
      // Real traffic: idempotent per process, inert until this composition runs.
      ensureAgentActivitySweep();
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
      // ADR 0059. The same `agents.getById` lookup `agentBelongsToWorkspace`/
      // `agentBelongsToComputer` already run above — no dedicated query, never cached.
      agentVisibility: async (workspaceId, agentId) => {
        const agent = await agents.getById(agentId);
        return agent?.workspaceId === workspaceId ? agent.visibility : undefined;
      },
      publish: centrifugo ? (channel, data) => centrifugo.publish(channel, data) : undefined,
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
