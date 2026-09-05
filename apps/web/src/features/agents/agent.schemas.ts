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
  model: z.string().trim().max(200).optional(),
  modelProvider: z.string().trim().max(100).optional(),
  reasoning: z.string().trim().max(50).optional(),
  computerId: z.string().min(1),
});

export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;

export const updateAgentInputSchema = createAgentInputSchema.omit({ computerId: true }).extend({
  agentId: z.uuid(),
});
export type UpdateAgentInput = z.infer<typeof updateAgentInputSchema>;

export const agentIdSchema = z.uuid();
export const saveAgentRuntimeCredentialInputSchema = z.object({
  agentId: agentIdSchema,
  apiKey: z.string().trim().min(8).max(4096),
});
