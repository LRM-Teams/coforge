/**
 * The agent environment rule, shared by the two edges that enforce it: the Web API validates what a
 * Workspace submits, and the daemon re-validates the environment it receives before spawning a code
 * agent. Both used to spell all of it out — the count limit, the name grammar, the reserved names and
 * the two size limits — so a payload the first edge accepted could be refused by the second.
 *
 * The reserved names are part of the rule rather than of either edge: a variable that shadows `PATH`,
 * or that claims the `COFORGE_` namespace, has to be refused wherever the environment is read.
 */
export const AGENT_ENVIRONMENT_MAX_VARIABLES = 64;
export const AGENT_ENVIRONMENT_MAX_NAME_LENGTH = 128;
export const AGENT_ENVIRONMENT_MAX_VALUE_LENGTH = 32_768;
export const AGENT_ENVIRONMENT_MAX_SERIALIZED_LENGTH = 131_072;

/** The variable-name grammar: a shell-identifier shape, so a name always survives `env`. */
export const AGENT_ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names no environment may set: `PATH` belongs to the runtime, `COFORGE_` to the daemon. */
export function isReservedAgentEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  return upper === "PATH" || upper.startsWith("COFORGE_");
}

/** The rule an environment breaks, named so an edge can refuse it with a reason instead of a guess. */
export type AgentEnvironmentViolation =
  | "too-many"
  | "invalid-name"
  | "reserved-name"
  | "invalid-value"
  | "too-large";

export function agentEnvironmentNameViolation(
  name: string,
): Extract<AgentEnvironmentViolation, "invalid-name" | "reserved-name"> | undefined {
  if (!AGENT_ENVIRONMENT_NAME_PATTERN.test(name) || name.length > AGENT_ENVIRONMENT_MAX_NAME_LENGTH)
    return "invalid-name";
  if (isReservedAgentEnvironmentName(name)) return "reserved-name";
  return undefined;
}

/** The first rule `environment` breaks, in the order count, each name and value, then total size. */
export function agentEnvironmentViolation(
  environment: Readonly<Record<string, unknown>>,
): AgentEnvironmentViolation | undefined {
  const entries = Object.entries(environment);
  if (entries.length > AGENT_ENVIRONMENT_MAX_VARIABLES) return "too-many";
  for (const [name, value] of entries) {
    const nameViolation = agentEnvironmentNameViolation(name);
    if (nameViolation) return nameViolation;
    if (
      typeof value !== "string" ||
      value.includes("\0") ||
      value.length > AGENT_ENVIRONMENT_MAX_VALUE_LENGTH
    )
      return "invalid-value";
  }
  if (JSON.stringify(environment).length > AGENT_ENVIRONMENT_MAX_SERIALIZED_LENGTH)
    return "too-large";
  return undefined;
}
