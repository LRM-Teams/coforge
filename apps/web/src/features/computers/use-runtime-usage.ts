import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

import { readUsage } from "./computers.functions";
import { scanRuntimeUsage } from "./usage-scan";

export function runtimeUsageQueryKey(computerId: string, provider: RuntimeProvider) {
  return ["runtime-usage", computerId, provider] as const;
}

/**
 * One (Computer, provider) runtime's usage cache: read on mount, kept warm by at most one
 * automatic scan when that cached read comes back stale or missing, and a manual `refresh` for
 * everything else. `RuntimeUsage` is the only caller; it owns deciding whether a provider's usage
 * is worth reading at all (`enabled`) and whether the Computer is known offline.
 */
export function useRuntimeUsage(
  computerId: string,
  provider: RuntimeProvider,
  options: { enabled: boolean; computerOnline?: boolean },
) {
  const { enabled, computerOnline } = options;
  const queryClient = useQueryClient();
  const queryKey = runtimeUsageQueryKey(computerId, provider);
  const query = useQuery({
    queryKey,
    queryFn: () => readUsage({ data: { computerId, provider } }),
    enabled,
    staleTime: 15_000,
  });
  const scan = useMutation({
    mutationFn: () => scanRuntimeUsage(computerId, provider),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result);
    },
  });

  // A ref, not state: the guard must survive a scan that finishes still stale (no live session
  // to observe from) without firing again, and must reset only when the target itself changes.
  const autoScanTarget = `${computerId}:${provider}`;
  const autoScanned = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!enabled || !query.data || computerOnline === false) return;
    if (query.data.state === "fresh") return;
    if (autoScanned.current === autoScanTarget) return;
    autoScanned.current = autoScanTarget;
    scan.mutate();
  }, [enabled, query.data, computerOnline, autoScanTarget, scan.mutate]);

  return {
    data: query.data,
    scanning: scan.isPending,
    /** The last scan got no result from the Computer in time; the cached result still shows. */
    scanFailed: scan.isError,
    refresh: () => scan.mutate(),
  };
}
