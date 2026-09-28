import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { listAgentModels } from "./agents.functions";
import { useCurrentWorkspaceId } from "./workspace-agents-realtime";

/** The query key of the Workspace's Agent models; a runtime change invalidates it. */
export const agentModelsQueryKey = (workspaceId: string | undefined) =>
  ["agent-models", workspaceId ?? null] as const;

/**
 * One Agent's configured model, for the label beside its name in chat. The Workspace's models
 * are one query (every Agent the viewer may see, read once and again on focus); each caller
 * selects only its own Agent, so a change re-renders the rows of that Agent alone. `enabled` off
 * (Settings → Show agent model) reads nothing.
 */
export function useAgentModel(agentId: string, enabled: boolean): string | undefined {
  const workspaceId = useCurrentWorkspaceId();
  const load = useServerFn(listAgentModels);
  const select = useCallback((models: Record<string, string>) => models[agentId], [agentId]);
  return useQuery({
    queryKey: agentModelsQueryKey(workspaceId),
    queryFn: () => load(),
    enabled: enabled && Boolean(workspaceId),
    staleTime: 5 * 60 * 1000,
    select,
  }).data;
}
