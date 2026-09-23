import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getAgentContextReport, scanAgentContext } from "./agent-context-report.functions";

export function agentContextReportQueryKey(agentId: string) {
  return ["agent-context-report", agentId] as const;
}

export type AgentContextReadResult = Awaited<ReturnType<typeof getAgentContextReport>>;

/**
 * One Agent's context-composition cache: read on mount, kept warm by at most one
 * automatic scan when that cached read comes back stale or missing, and a manual `refresh` for
 * everything else. `AgentContextPopoverContent` is the only consumer; it owns rendering every
 * non-available state (`unsupported`, `no_session`, `unparsed`, `timeout`, `error`) inline.
 */
export function useAgentContextReport(
  agentId: string,
  options: { enabled: boolean; computerOnline?: boolean },
) {
  const { enabled, computerOnline } = options;
  const queryClient = useQueryClient();
  const queryKey = agentContextReportQueryKey(agentId);
  const query = useQuery({
    queryKey,
    queryFn: () => getAgentContextReport({ data: agentId }),
    enabled,
    staleTime: 15_000,
    retry: false,
  });
  const scan = useMutation({
    mutationFn: () => scanAgentContext({ data: agentId }),
    onSuccess: (result) => {
      if (!("result" in result) || !result.result) return;
      queryClient.setQueryData(queryKey, {
        state: result.state,
        result: result.result,
      });
    },
  });

  // A ref, not state: the guard must survive a scan that finishes still stale (no live session
  // to read from) without firing again, and must reset only when the target itself changes.
  const autoScanned = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!enabled || !query.data || computerOnline === false) return;
    if (query.data.state === "fresh") return;
    if (autoScanned.current === agentId) return;
    autoScanned.current = agentId;
    scan.mutate();
  }, [enabled, query.data, computerOnline, agentId, scan.mutate]);

  return {
    data: query.data,
    scanning: scan.isPending,
    /** The last scan got no result from the Computer in time; the cached result still shows. */
    scanFailed: scan.isError,
    refresh: () => scan.mutate(),
  };
}
