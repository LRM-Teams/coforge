import { useRouter } from "@tanstack/react-router";

import { formatAgentProfileParam, type AgentProfileTab } from "./profile-panel-search";

/** The subset of either conversation route's search this hook reads/writes. A narrow local type
 * (not `Record<string, unknown>`) so `router.navigate({ to: "." })`'s search updater still
 * type-checks without pinning to one specific route — the same pattern
 * `use-conversation-view.ts`'s `update()` uses for `view`/`layout`. */
type AgentProfileSearch = { profile?: string; agentTab?: AgentProfileTab };

/**
 * The one way a conversation page opens/closes/switches the Agent profile panel. Per
 * `apps/web/AGENTS.md` ("the conversations feature does not own Agent state"), conversation
 * components call this instead of writing `profile`/`agentTab` search params themselves.
 *
 * Opening pushes a history entry (plain `router.navigate` without `replace`, the same default
 * every other search-param writer on these routes already relies on — see
 * `use-conversation-view.ts`), so browser Back closes the panel. Closing and tab switches replace
 * in place: neither should itself become a Back stop once the panel is already open.
 */
export function useOpenAgentProfile() {
  const router = useRouter();
  const openAgentProfile = (agentId: string, tab?: AgentProfileTab) =>
    void router.navigate({
      to: ".",
      search: (previous: AgentProfileSearch) => ({
        ...previous,
        profile: formatAgentProfileParam(agentId),
        ...(tab ? { agentTab: tab } : {}),
      }),
    });
  const setAgentProfileTab = (tab: AgentProfileTab) =>
    void router.navigate({
      to: ".",
      replace: true,
      search: (previous: AgentProfileSearch) => ({ ...previous, agentTab: tab }),
    });
  const closeAgentProfile = () =>
    void router.navigate({
      to: ".",
      replace: true,
      search: (previous: AgentProfileSearch) => {
        const { profile: _profile, agentTab: _agentTab, ...rest } = previous;
        return rest;
      },
    });
  return { openAgentProfile, setAgentProfileTab, closeAgentProfile };
}
