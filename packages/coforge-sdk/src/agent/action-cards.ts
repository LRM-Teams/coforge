import { z } from "zod";

/**
 * Agent-prepared action card contract, mirroring Raft Computer 1.0.32's
 * `packages/shared/src/actionCards.ts` (`raft action prepare`; see
 * `docs/agents/reference-cli-research.md`). CoForge v1 supports exactly three
 * card kinds: `channel:create`, `agent:create`, `channel:add_member`. Raft's
 * `integration:*` kinds are intentionally out of scope for this PR.
 *
 * An Agent identifies humans, Agents, channels, and computers by handle
 * (`@alice`, `alice`, `#general`, `general`) or UUID. `ActionCards.prepare`
 * (see `apps/web/src/server/conversations/action-cards.server.ts`) resolves
 * every handle to a UUID before persisting the card; Agents never see or
 * write UUIDs in an action card payload.
 */

/** A handle (`@alice` / `alice` / `#general`) or a UUID; resolved server-side at prepare time. */
export const idOrHandleSchema = z.string().trim().min(1).max(120);

/** Why the Agent prepared this for a human. Shown below the card form; not the action itself. */
export const draftHintSchema = z
  .string()
  .trim()
  .max(2000)
  .optional()
  .describe(
    "Why the agent prepared this for you. Shows below the form on the card; not the action itself.",
  );

/** CoForge public-channel name rule (see `public-channels.server.ts#create`). */
const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** CoForge Agent name rule (see `apps/web/src/features/agents/agent.schemas.ts`). */
const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Strips one leading `#` before validating against the channel name rule. */
const channelNameSchema = z
  .string()
  .trim()
  .transform((value) => (value.startsWith("#") ? value.slice(1) : value))
  .pipe(z.string().min(1).max(32).regex(CHANNEL_NAME_PATTERN));

export const channelCreateActionSchema = z.object({
  type: z.literal("channel:create"),
  name: channelNameSchema,
  visibility: z.enum(["public", "private"]).default("public"),
  description: z.string().trim().max(500).optional(),
  /**
   * Humans to add to the channel on creation. Each entry is a handle
   * (`@alice` or bare `alice`) or a UUID; resolved at prepare time.
   */
  initialHumans: z.array(idOrHandleSchema).max(64).optional(),
  /**
   * Agents to add to the channel on creation. Each entry is a handle
   * (`@scout` or bare `scout`) or a UUID; resolved at prepare time.
   */
  initialAgents: z.array(idOrHandleSchema).max(64).optional(),
  draftHint: draftHintSchema,
});
export type ChannelCreateAction = z.infer<typeof channelCreateActionSchema>;

export const agentCreateActionSchema = z.object({
  type: z.literal("agent:create"),
  name: z.string().trim().min(1).max(64).regex(AGENT_NAME_PATTERN),
  description: z.string().trim().max(500).optional(),
  /**
   * Optional computer placement contract. Runtime / model / reasoning effort
   * remain human-picked technical fields and are never part of this contract.
   * `suggestedComputer` preselects the create dialog; `requiredComputer`
   * prevents silent fallback to any other computer. At most one may be set
   * (see `validateActionCardAction`).
   */
  suggestedComputer: idOrHandleSchema.optional(),
  requiredComputer: idOrHandleSchema.optional(),
  draftHint: draftHintSchema,
});
export type AgentCreateAction = z.infer<typeof agentCreateActionSchema>;

export const channelAddMemberActionSchema = z.object({
  type: z.literal("channel:add_member"),
  /** Target channel: handle (`#general` or bare `general`) or UUID; resolved at prepare time. */
  channel: idOrHandleSchema,
  /** Same resolution rule as `channelCreateActionSchema.initialHumans`. */
  humans: z.array(idOrHandleSchema).max(64).optional(),
  /** Same resolution rule as `channelCreateActionSchema.initialAgents`. */
  agents: z.array(idOrHandleSchema).max(64).optional(),
  draftHint: draftHintSchema,
});
export type ChannelAddMemberAction = z.infer<typeof channelAddMemberActionSchema>;

export const actionCardActionSchema = z.discriminatedUnion("type", [
  channelCreateActionSchema,
  agentCreateActionSchema,
  channelAddMemberActionSchema,
]);
export type ActionCardAction = z.infer<typeof actionCardActionSchema>;
export type ActionCardKind = ActionCardAction["type"];

/**
 * Cross-field rules the schema alone cannot express, mirroring Raft's
 * `validateActionCardAction`. Returns a human-readable message, or `null`
 * when the action is valid.
 */
export function validateActionCardAction(action: ActionCardAction): string | null {
  if (action.type === "agent:create") {
    if (action.suggestedComputer && action.requiredComputer)
      return "agent:create must include only one of suggestedComputer or requiredComputer";
  }
  if (action.type === "channel:add_member") {
    const total = (action.humans?.length ?? 0) + (action.agents?.length ?? 0);
    if (total === 0) return "channel:add_member must include at least one human or agent";
  }
  return null;
}

/** The resolved, UUID-only payload stored server-side on the `ActionCard` row (`payload` column). */
export type ResolvedChannelCreatePayload = {
  type: "channel:create";
  name: string;
  visibility: "public" | "private";
  description?: string;
  initialHumanIds?: string[];
  initialAgentIds?: string[];
};
export type ResolvedAgentCreatePayload = {
  type: "agent:create";
  name: string;
  description?: string;
  suggestedComputerId?: string;
  requiredComputerId?: string;
};
export type ResolvedChannelAddMemberPayload = {
  type: "channel:add_member";
  channelId: string;
  humanIds?: string[];
  agentIds?: string[];
};
export type ResolvedActionCardPayload =
  | ResolvedChannelCreatePayload
  | ResolvedAgentCreatePayload
  | ResolvedChannelAddMemberPayload;

/** `POST /api/agent/v1/actions/prepare` request body. */
export type AgentActionPrepareRequest = {
  target: string;
  action: ActionCardAction;
};

/** `POST /api/agent/v1/actions/prepare` success response. */
export type AgentActionPrepareResponse = {
  messageId: string;
  metadata: { kind: "action-card" };
};
