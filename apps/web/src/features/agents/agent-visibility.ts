/**
 * Per-Agent visibility (ADR 0059). `"public"` is visible
 * Workspace-wide; `"private"` is visible only to its creator, other Agents sharing that same
 * creator, and a viewer whose own server role is owner/admin. Every Agent defaults to `"public"`;
 * new weekly-report Collector Agents (ADR 0032) and WeeklyReportAssistant Agents are created
 * `"private"`.
 *
 * Kept Web-only (not part of `@lrm/coforge-sdk`): visibility is never sent to the Daemon or
 * carried over the wire protocol, only enforced by the Web/backend seam that reads it.
 */
export const AGENT_VISIBILITY = {
  PUBLIC: "public",
  PRIVATE: "private",
} as const;
export type AgentVisibility = (typeof AGENT_VISIBILITY)[keyof typeof AGENT_VISIBILITY];

/** Every `AgentVisibility` value, for a zod `z.enum` or other exhaustive-tuple consumer. */
export const AGENT_VISIBILITY_VALUES = Object.values(AGENT_VISIBILITY) as [
  AgentVisibility,
  ...AgentVisibility[],
];

const AGENT_VISIBILITIES: ReadonlySet<string> = new Set(AGENT_VISIBILITY_VALUES);

/** The `AgentVisibility` a persisted or user-supplied value names, or false for anything else. */
export function isAgentVisibility(value: string): value is AgentVisibility {
  return AGENT_VISIBILITIES.has(value);
}
