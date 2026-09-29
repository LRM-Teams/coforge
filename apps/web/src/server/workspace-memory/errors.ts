export const WORKSPACE_MEMORY_FAILURE_CODES = [
  "prototype_disabled",
  "stale_generation",
  "invalid_profile",
  "invalid_transition",
  "invalid_segment",
  "invalid_cursor",
  "provisioning_failed",
] as const;
export type WorkspaceMemoryFailureCode = (typeof WORKSPACE_MEMORY_FAILURE_CODES)[number];

export type SanitizedFailure = {
  code: WorkspaceMemoryFailureCode;
  message: string;
};

const FAILURE_MESSAGES: Record<WorkspaceMemoryFailureCode, string> = {
  prototype_disabled: "OpenViking prototype is not enabled",
  stale_generation: "profile generation is stale",
  invalid_profile: "workspace memory profile is invalid",
  invalid_transition: "workspace memory transition is invalid",
  invalid_segment: "admitted segment is invalid",
  invalid_cursor: "activation cursor is invalid",
  provisioning_failed: "memory runtime provisioning failed",
};

export function sanitizeWorkspaceMemoryFailure(
  code: WorkspaceMemoryFailureCode,
  raw?: string,
): SanitizedFailure {
  void raw;
  return { code, message: FAILURE_MESSAGES[code] };
}
