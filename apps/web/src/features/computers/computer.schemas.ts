import { z } from "zod";
import { RUNTIME_PROVIDER } from "@coforge/protocol";

const runtimeInput = z.object({
  computerId: z.string().min(1),
  provider: z.enum(RUNTIME_PROVIDER),
});

export const computerIdInputSchema = z.object({ computerId: z.string().min(1) });
export const scanUsageInputSchema = runtimeInput;
export const readUsageInputSchema = runtimeInput;
export const setRuntimeVisibilityInputSchema = z.object({
  runtimeId: z.string().min(1),
  isPublic: z.boolean(),
});
