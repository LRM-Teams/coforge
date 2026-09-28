import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { listAgentModels } from "./agents.functions";

/** The query key of the Workspace's Agent models. Invalidated when an Agent's runtime is saved
 * or an Agent's visibility changes. */
export const agentModelsQueryKey = (workspaceId: string | undefined) =>
  ["agent-models", workspaceId ?? null] as const;

/**
 * One Agent's configured model, for the label beside its name in chat; `""` for an Agent on its
 * runtime's default model. The Workspace's models are one query (every Agent the viewer may
 * see), read again whenever the page regains focus or the network reconnects; each caller
 * selects only its own Agent, so a change re-renders the rows of that Agent alone.
 *
 * `seenAt` is when this Agent was last seen acting (its message's time, the server's clock). An
 * Agent the list does not have, seen after the server read the list, was created since: the list
 * is read again, once — a list read after `seenAt` that still lacks it is not read again for it.
 */
export function useAgentModel(
  workspaceId: string,
  agentId: string,
  seenAt: Date | string,
): string | undefined {
  const load = useServerFn(listAgentModels);
  const queryClient = useQueryClient();
  const queryKey = agentModelsQueryKey(workspaceId);
  const select = useCallback(
    (list: { models: Record<string, string> }) => list.models[agentId],
    [agentId],
  );
  const { data: model, isSuccess } = useQuery({
    queryKey,
    queryFn: () => load(),
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    select,
  });
  const unknown = isSuccess && model === undefined;
  const seenAtMs = new Date(seenAt).getTime();
  useEffect(() => {
    if (!unknown) return;
    const key = agentModelsQueryKey(workspaceId);
    // The list's own server read time, not the browser clock: message times are the server's.
    const readAt = queryClient.getQueryData<{ readAt: number }>(key)?.readAt ?? 0;
    // Several new rows can ask in one commit; the first read serves them all.
    if (seenAtMs > readAt)
      void queryClient.invalidateQueries({ queryKey: key }, { cancelRefetch: false });
  }, [unknown, seenAtMs, queryClient, workspaceId]);
  return model;
}
