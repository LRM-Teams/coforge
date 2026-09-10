import { z } from "zod";

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

const apiKeySchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(8).max(4096).optional(),
);

const agentInputShape = {
  name: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().max(500).default(""),
  provider: z.enum(["coforge", "pi", "codex", "claude-code", "kiro"]),
  model: z.string().trim().max(200).optional(),
  modelProvider: z.string().trim().max(100).optional(),
  reasoning: z.string().trim().max(50).optional(),
  apiKey: apiKeySchema,
};

function validateRuntimeKey(
  value: { provider: string; modelProvider?: string; apiKey?: string },
  context: z.RefinementCtx,
) {
  if (!value.apiKey) return;
  if (value.provider !== "pi" && value.provider !== "coforge") {
    context.addIssue({ code: "custom", path: ["apiKey"], message: "Unsupported runtime key" });
  }
  if (!value.modelProvider) {
    context.addIssue({ code: "custom", path: ["modelProvider"], message: "Required for API key" });
  }
  if (value.provider === "pi" && !KEYED_MODEL_PROVIDERS.has(value.modelProvider ?? "")) {
    context.addIssue({
      code: "custom",
      path: ["modelProvider"],
      message: "Unsupported Pi API key provider",
    });
  }
}

export const createAgentInputSchema = z
  .object({ ...agentInputShape, computerId: z.string().min(1) })
  .superRefine(validateRuntimeKey);

export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;

export const updateAgentInputSchema = z
  .object({ ...agentInputShape, agentId: z.uuid() })
  .superRefine(validateRuntimeKey);
export type UpdateAgentInput = z.infer<typeof updateAgentInputSchema>;

export const agentIdSchema = z.uuid();
export const saveAgentRuntimeCredentialInputSchema = z.object({
  agentId: agentIdSchema,
  apiKey: z.string().trim().min(8).max(4096),
});

export const saveAgentEnvironmentInputSchema = z.object({
  agentId: agentIdSchema,
  envVars: z.record(z.string(), z.string()),
});
