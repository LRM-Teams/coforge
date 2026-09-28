import { useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";

import {
  getComputerRuntimeCatalog,
  listComputers,
} from "#src/features/computers/computers.functions";
import type { RuntimeOptions } from "./agent-runtime-fields";

/**
 * The `AgentRuntimeFields.onLoad` loader shared by the full Agent detail page's edit dialog
 * (`agents.$agentId.tsx`) and the Profile panel's in-place runtime editor
 * (`profile-panel/agent-profile-panel.tsx`): the Computer's supported providers plus its model
 * catalog for the selected provider, one shared shape so neither caller copies the other.
 */
export function useAgentRuntimeOptionsLoader(): (computerId: string) => Promise<RuntimeOptions> {
  const loadComputers = useServerFn(listComputers);
  const loadCatalog = useServerFn(getComputerRuntimeCatalog);
  return useCallback(
    async (computerId: string): Promise<RuntimeOptions> => {
      const [computers, catalogs] = await Promise.all([
        loadComputers(),
        loadCatalog({ data: { computerId } }),
      ]);
      return {
        providers:
          computers
            .find((computer) => computer.id === computerId)
            ?.runtimes.map((runtime) => runtime.provider) ?? [],
        catalogs,
      };
    },
    [loadComputers, loadCatalog],
  );
}
