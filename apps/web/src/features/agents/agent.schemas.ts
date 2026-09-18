import { z } from "zod";
import {
  RUNTIME_PROVIDER,
  RUNTIME_PROVIDER_USES_EXTERNAL_CLI,
  RUNTIME_PROVIDER_VALUES,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";

export const KEYED_MODEL_PROVIDERS = new Set([
  "deepseek",
  "minimax",
  "minimax-cn",
  "zai",
  "zai-coding-cn",
  "moonshotai",
  "moonshotai-cn",
  "kimi-coding",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "openrouter",
  "openai",
  "anthropic",
  "google",
  "xai",
  "xiaomi",
]);

/** The Pi runtime's own built-in providers, offered directly in the Pi "Provider" picker
 * alongside "Configured" (the Computer's own `~/.pi/agent` setup). A narrower set than
 * `KEYED_MODEL_PROVIDERS` (CoForge's full keyed-provider catalog): Pi only ever launches with an
 * Agent-entered key for one of these two. */
export const PI_BUILTIN_MODEL_PROVIDERS = ["deepseek", "openrouter"] as const;
const PI_BUILTIN_MODEL_PROVIDER_SET: ReadonlySet<string> = new Set(PI_BUILTIN_MODEL_PROVIDERS);
export function isPiBuiltinModelProvider(value: string): boolean {
  return PI_BUILTIN_MODEL_PROVIDER_SET.has(value);
}

const apiKeySchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(8).max(4096).optional(),
);

// The @mention username: fixed at creation (Raft 1.0.32 alignment), never renamed afterward.
const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const AGENT_DISPLAY_NAME_MAX_LENGTH = 80;

// Free-text label, independent of `name`; any charset. Editable only after creation, where it
// defaults to the username.
const displayNameSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(AGENT_DISPLAY_NAME_MAX_LENGTH).optional(),
);

const agentInputShape = {
  description: z.string().trim().max(500).default(""),
  provider: z.enum(RUNTIME_PROVIDER_VALUES),
  model: z.string().trim().max(200).optional(),
  modelProvider: z.string().trim().max(100).optional(),
  reasoning: z.string().trim().max(50).optional(),
  apiKey: apiKeySchema,
};

function validateRuntimeKey(
  value: { provider: RuntimeProvider; modelProvider?: string; apiKey?: string },
  context: z.RefinementCtx,
) {
  if (!value.apiKey) return;
  if (RUNTIME_PROVIDER_USES_EXTERNAL_CLI[value.provider]) {
    context.addIssue({ code: "custom", path: ["apiKey"], message: "Unsupported runtime key" });
  }
  if (!value.modelProvider) {
    context.addIssue({ code: "custom", path: ["modelProvider"], message: "Required for API key" });
  }
  if (
    value.provider === RUNTIME_PROVIDER.PI &&
    !isPiBuiltinModelProvider(value.modelProvider ?? "")
  ) {
    context.addIssue({
      code: "custom",
      path: ["modelProvider"],
      message: "Unsupported Pi API key provider",
    });
  }
}

export const createAgentInputSchema = z
  .object({
    ...agentInputShape,
    name: nameSchema,
    computerId: z.string().min(1),
    /** Present when this create submits an Agent-prepared `agent:create` action card
     * (ADR 0027 "Commit and cancel"); marks the card `executed` after the Agent is created. */
    actionCardMessageId: z.uuid().optional(),
  })
  .superRefine(validateRuntimeKey);

export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;

export const updateAgentInputSchema = z
  .object({
    ...agentInputShape,
    displayName: displayNameSchema,
    agentId: z.uuid(),
    computerId: z.string().min(1).optional(),
  })
  .superRefine(validateRuntimeKey);
export type UpdateAgentInput = z.infer<typeof updateAgentInputSchema>;

export const agentIdSchema = z.uuid();
/** ADR 0044: deleting an Agent is name-confirmed, the same guard `ProjectSettings.delete` uses —
 * the server re-checks the typed name against the current row in the delete itself, so a
 * concurrent rename cannot bypass confirmation. */
export const deleteAgentInputSchema = z.object({
  agentId: agentIdSchema,
  confirmation: z.string().trim().min(1).max(64),
});
export type DeleteAgentInput = z.infer<typeof deleteAgentInputSchema>;
export const updateAgentRoleInputSchema = z.object({
  agentId: agentIdSchema,
  role: z.enum(["admin", "member"]),
});
export type UpdateAgentRoleInput = z.infer<typeof updateAgentRoleInputSchema>;
export const saveAgentRuntimeCredentialInputSchema = z.object({
  agentId: agentIdSchema,
  apiKey: z.string().trim().min(8).max(4096),
});

export const saveAgentEnvironmentInputSchema = z.object({
  agentId: agentIdSchema,
  envVars: z.record(z.string(), z.string()),
});

// A thin gate ahead of the codec's own strict validation (`agent-workspace-files.ts` rejects
// control bytes, `..` segments, absolute/Windows paths, etc. on encode) — this just rejects
// wildly wrong types/sizes before that.
export const listAgentWorkspaceFilesInputSchema = z.object({
  agentId: agentIdSchema,
  dirPath: z.string().max(4096).default(""),
  includeHidden: z.boolean().default(false),
});
export type ListAgentWorkspaceFilesInput = z.infer<typeof listAgentWorkspaceFilesInputSchema>;

export const readAgentWorkspaceFileInputSchema = z.object({
  agentId: agentIdSchema,
  path: z.string().min(1).max(4096),
});
export type ReadAgentWorkspaceFileInput = z.infer<typeof readAgentWorkspaceFileInputSchema>;
