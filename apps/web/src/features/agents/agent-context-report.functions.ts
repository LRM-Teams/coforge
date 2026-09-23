import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { agentIdSchema } from "./agent.schemas";
import { AppError } from "@/lib/app-error";
import { workspaceUserMiddleware } from "../../server/auth/function-auth";
import {
  readAgentContextReport,
  scanAgentContextReport,
} from "../../server/agents/agent-context-report.server";
import { waitForUsageScanResult } from "../computers/usage-poll";

/**
 * The Agent profile panel's context-composition read: the last stored report plus its
 * freshness state, exactly the shape the runtime usage popover reads. Unavailable for a viewer
 * who does not own the Agent, an Agent without a Claude Code runtime, or an Agent with no
 * Computer at all.
 */
export const getAgentContextReport = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdSchema)
  .handler(async ({ data: agentId, context }) => {
    setResponseHeader("Cache-Control", "no-store");
    const { user, db, workspaceId } = context;
    const read = await readAgentContextReport(db, { userId: user.id, workspaceId }, agentId);
    if (read.status === "unavailable") throw new AppError("AGENT_CONTEXT_UNAVAILABLE");
    return read.read;
  });

/**
 * Runs a fresh context-composition scan against the Agent's Computer and waits for
 * that scan's own result — the previously cached report (if any) stays readable through
 * `getAgentContextReport` the whole time. Refused with a stable code for a non-Claude-Code Agent
 * or a viewer who does not own the Agent.
 */
export const scanAgentContext = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdSchema)
  .handler(async ({ data: agentId, context }) => {
    const { user, db, workspaceId } = context;
    const viewer = { userId: user.id, workspaceId };
    const started = await scanAgentContextReport(db, viewer, agentId);
    if ("status" in started) throw new AppError("AGENT_CONTEXT_UNAVAILABLE");
    const read = () =>
      readAgentContextReport(db, viewer, agentId).then((read) => {
        if (read.status !== "ready") throw new Error("Agent context report is not available");
        return read.read;
      });
    // The scan outliving its poll window is not an error of its own: the cached read still
    // answers, and the pending marker expires on its own. Same contract as the runtime usage
    // scan's poll timeout.
    const result = await waitForUsageScanResult(started.scanId, read).catch(() =>
      read().catch(() => ({ state: "missing" as const })),
    );
    return { scanId: started.scanId, ...result };
  });
