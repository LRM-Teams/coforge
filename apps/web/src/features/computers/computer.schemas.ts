import { z } from "zod";
import { RUNTIME_PROVIDER } from "@coforge/protocol";

export type ComputerRestartStatus =
  | { requestId: string; status: "accepted"; expiresAt: string }
  | {
      requestId: string;
      status: "completed";
      completedAt: string;
      workerInstanceId: string;
      daemonVersion: string;
      startedAt: number;
    }
  | { requestId: string; status: "failed"; reason: "timeout" | "publication" };

const runtimeInput = z.object({
  computerId: z.string().min(1),
  provider: z.enum(RUNTIME_PROVIDER),
});

export const computerIdInputSchema = z.object({ computerId: z.string().min(1) });
export const restartComputerInputSchema = z.object({
  computerId: z.string().min(1),
  requestId: z.uuid(),
});
export const readRestartStatusInputSchema = restartComputerInputSchema;
export const scanUsageInputSchema = runtimeInput;
export const readUsageInputSchema = runtimeInput;
export const setRuntimeVisibilityInputSchema = z.object({
  runtimeId: z.string().min(1),
  isPublic: z.boolean(),
});
export const updateComputerDisplayNameInputSchema = z.object({
  computerId: z.string().min(1),
  displayName: z.string().trim().min(1).max(200),
});
