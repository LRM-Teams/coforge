import { useCallback, useEffect } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";

import { listAgentModels } from "./agents.functions";

/** The query key of the Workspace's Agent models. Invalidated when an Agent's runtime is saved
 * or an Agent's visibility changes. */
export const agentModelsQueryKey = (workspaceId: string | undefined) =>
  ["agent-models", workspaceId ?? null] as const;

/** The Workspace's Agent models, read again whenever the page regains focus or the network
 * reconnects. Typed from `listAgentModels`, so a change to its shape fails the type check. */
const agentModelsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: agentModelsQueryKey(workspaceId),
    queryFn: () => listAgentModels(),
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });

type AgentModels = Awaited<ReturnType<typeof listAgentModels>>;

/**
 * One Agent's configured model, for the label beside its name in chat; `""` for an Agent on its
 * runtime's default model. The Workspace's models are one query (every Agent the viewer may
 * see); each caller selects only its own Agent, so a change re-renders the rows of that Agent
 * alone.
 *
 * `seenAt` is when this Agent was last seen acting (its message's time, the server's clock). An
 * Agent the list does not have, seen after the server read the list, was created since: the list
 * is read again. For such an Agent the selection is the list's `readAt` (a number), which changes
 * with every read, so a read that was already under way when the row appeared is checked again;
 * once a list read after `seenAt` still lacks it, it is not read again for it.
 */
export function useAgentModel(
  workspaceId: string,
  agentId: string,
  seenAt: Date | string,
): string | undefined {
  const queryClient = useQueryClient();
  const select = useCallback(
    (list: AgentModels): string | number => list.models[agentId] ?? list.readAt,
    [agentId],
  );
  const { data } = useQuery({ ...agentModelsQuery(workspaceId), select });
  const seenAtMs = new Date(seenAt).getTime();
  // Several new rows can ask in one commit; the first read serves them all.
  useEffect(() => {
    if (typeof data === "number" && seenAtMs > data)
      void queryClient.invalidateQueries(
        { queryKey: agentModelsQueryKey(workspaceId) },
        { cancelRefetch: false },
      );
  }, [data, seenAtMs, queryClient, workspaceId]);
  return typeof data === "string" ? data : undefined;
}
