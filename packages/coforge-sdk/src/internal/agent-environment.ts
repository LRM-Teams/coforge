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
