import { z } from "zod";

export const createAgentInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(500),
  provider: z.enum(["coforge", "pi", "codex", "claude-code"]),
  model: z.string().optional(),
  modelProvider: z.string().optional(),
  reasoning: z.string().optional(),
  computerId: z.string().min(1),
});

export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;

export const agentIdSchema = z.uuid();
export const saveAgentRuntimeCredentialInputSchema = z.object({
  agentId: agentIdSchema,
  apiKey: z.string().min(1),
});
