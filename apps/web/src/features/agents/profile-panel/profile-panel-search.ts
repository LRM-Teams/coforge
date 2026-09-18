import { z } from "zod";

/**
 * The Agent profile panel's URL state, shared by both conversation routes
 * (`messages.$agentId.tsx`, `messages.channels.$channelId.tsx`): `profile=agent:<uuid>` opens the
 * panel on a given Agent, `agentTab` selects its tab. Kept in its own module so the search-param
 * shape, its zod validators and the tiny encode/decode helpers have one home the routes and the
 * panel both import, instead of separate copies of the same regex.
 */

const AGENT_PROFILE_PREFIX = "agent:";
const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`, "i");
const AGENT_PROFILE_PATTERN = new RegExp(`^${AGENT_PROFILE_PREFIX}${UUID_SOURCE}$`, "i");

export const AGENT_PROFILE_TABS = ["profile", "reminders", "activity"] as const;
export type AgentProfileTab = (typeof AGENT_PROFILE_TABS)[number];

/** Validates the raw `profile` search param: `undefined` or `agent:<uuid>`. Malformed values fall
 * back to `undefined` (closed) rather than erroring, matching the routes' existing `.catch()`
 * convention for `threadRootId`/`message`. */
export const agentProfileParamSchema = z
  .string()
  .regex(AGENT_PROFILE_PATTERN)
  .optional()
  .catch(undefined);

export const agentProfileTabParamSchema = z.enum(AGENT_PROFILE_TABS).optional().catch(undefined);

/** The `profile` search param value that opens the panel on one Agent. */
export function formatAgentProfileParam(agentId: string): string {
  return `${AGENT_PROFILE_PREFIX}${agentId}`;
}

/** The Agent id encoded in a `profile` search param, or `undefined` when the panel is closed or
 * the param does not name an Agent (already validated by `agentProfileParamSchema`, but callers
 * that read raw search state — e.g. before validation — can use this defensively too). */
export function agentIdFromProfileParam(profile: string | undefined): string | undefined {
  if (!profile || !profile.startsWith(AGENT_PROFILE_PREFIX)) return undefined;
  const id = profile.slice(AGENT_PROFILE_PREFIX.length);
  return UUID_PATTERN.test(id) ? id : undefined;
}

/** The panel offers Profile, Reminders and Activity; Reminders and Activity are both
 * manager/owner-only (brief §Permissions). A requested tab a non-manager cannot see, or no
 * request at all, resolves to Profile. */
export function resolveAgentProfileTab(
  requested: AgentProfileTab | undefined,
  canSeeManagerTabs: boolean,
): AgentProfileTab {
  if ((requested === "activity" || requested === "reminders") && canSeeManagerTabs)
    return requested;
  return "profile";
}
