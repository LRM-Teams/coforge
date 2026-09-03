import type { UsageSnapshot, UsageWindow } from "../contract";
import { agentEnvironment } from "../environment";
import { JsonlProcess } from "../jsonl-process";
import { COFORGE_DAEMON_VERSION } from "../../version";
import { RUNTIME_PROVIDER } from "@coforge/protocol";

export async function readCodexUsage(
  workingDirectory: string,
  options: {
    command?: readonly string[];
    environment?: Readonly<Record<string, string>>;
    timeoutMs?: number;
  } = {},
): Promise<UsageSnapshot | null> {
  const process = new JsonlProcess(
    options.command ?? ["codex", "app-server"],
    workingDirectory,
    agentEnvironment(options.environment),
  );
  const timeoutMs = options.timeoutMs ?? 5_000;
  try {
    await withTimeout(
      process.request({
        method: "initialize",
        params: {
          clientInfo: {
            name: "coforge-daemon-usage",
            title: "CoForge Daemon Usage",
            version: COFORGE_DAEMON_VERSION,
          },
          capabilities: { experimentalApi: false },
        },
      }),
      timeoutMs,
    );
    await process.send({ method: "initialized", params: {} });
    const response = await withTimeout(
      process.request({ method: "account/rateLimits/read", params: {} }),
      timeoutMs,
    );
    return toSnapshot(response);
  } catch (error) {
    if (error instanceof UsageTimeoutError) throw error;
    return null;
  } finally {
    await process.dispose().catch(() => undefined);
  }
}

class UsageTimeoutError extends Error {
  constructor() {
    super("Codex usage request timed out");
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new UsageTimeoutError()), timeoutMs)),
  ]);
}

function toSnapshot(response: Readonly<Record<string, unknown>>): UsageSnapshot | null {
  const result = record(response.result);
  const nestedLimits = record(result?.rateLimits);
  const limits = nestedLimits ? { ...result, ...nestedLimits } : result;
  if (!limits) return null;
  const primary = toWindow(limits.primary);
  const secondary = toWindow(limits.secondary);
  if (!primary && !secondary && !("credits" in limits) && typeof limits.planType !== "string")
    return null;
  const credits = record(limits.credits);
  return {
    provider: RUNTIME_PROVIDER.CODEX,
    ...(typeof limits.planType === "string" ? { planType: limits.planType } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(credits && typeof credits.hasCredits === "boolean" && typeof credits.unlimited === "boolean"
      ? { credits: { hasCredits: credits.hasCredits, unlimited: credits.unlimited } }
      : {}),
  };
}

function toWindow(value: unknown): UsageWindow | undefined {
  const item = record(value);
  if (!item || typeof item.usedPercent !== "number" || typeof item.windowDurationMins !== "number")
    return undefined;
  const reset =
    typeof item.resetsAt === "number"
      ? new Date(item.resetsAt * 1000)
      : new Date(String(item.resetsAt));
  if (Number.isNaN(reset.getTime())) return undefined;
  return {
    usedPercent: item.usedPercent,
    windowDurationMinutes: item.windowDurationMins,
    resetsAt: reset.toISOString(),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
