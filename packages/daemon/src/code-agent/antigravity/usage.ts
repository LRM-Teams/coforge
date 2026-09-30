import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { runCatalogCommand } from "#src/code-agent/catalog-command";
import {
  UsageUnavailableError,
  UsageUnsupportedError,
  type UsageSnapshot,
  type UsageWindow,
} from "#src/code-agent/contract";
import { asRecord } from "#src/code-agent/json-record";
import { withoutSshSessionVariables } from "./ssh-environment";

/** How long `agy -p /usage` may run. It answers from the account's quota without starting a turn
 * or spending quota (agy 1.1.11 changelog), but still fetches over the network. */
export const ANTIGRAVITY_USAGE_TIMEOUT_MS = 15_000;

const WINDOW_MINUTES: Readonly<Record<string, number>> = { "5h": 300, weekly: 10_080 };

type QuotaBucket = { id: string; window: string; remaining: number; resetsAt?: string };
type QuotaGroup = { name: string; buckets: QuotaBucket[] };

/**
 * Reads the account's quota with `agy -p /usage --output-format json`. agy groups its models
 * (Gemini; Claude and GPT) and gives each group a 5-hour and a weekly limit as a remaining
 * fraction. The snapshot shows the group with the least quota left - the one that stops an Agent
 * first - as its 5-hour (primary) and weekly (secondary) windows, named in `planType`.
 */
export async function readAntigravityUsage(
  workingDirectory: string,
  options: {
    command?: readonly string[];
    environment?: Readonly<Record<string, string | undefined>>;
    timeoutMs?: number;
  } = {},
): Promise<UsageSnapshot> {
  const { output } = await runCatalogCommand(
    [...(options.command ?? ["agy"]), "-p", "/usage", "--output-format", "json"],
    workingDirectory,
    withoutSshSessionVariables(options.environment ?? Bun.env),
    options.timeoutMs ?? ANTIGRAVITY_USAGE_TIMEOUT_MS,
  );
  // A local wrapper may print a banner before the JSON answer; the answer starts at the first
  // line that opens an object and runs to the end.
  const start = output.startsWith("{") ? 0 : output.indexOf("\n{") + 1;
  const answer = asRecord(parseJson(output.slice(start)));
  if (answer?.status !== "SUCCESS") {
    const error = typeof answer?.error === "string" ? answer.error : "";
    if (!answer || /sign(?:ed)?[ -]?in|log(?:ged)?[ -]?in|auth/iu.test(error))
      throw new UsageUnavailableError();
    throw new Error(`agy /usage failed: ${error || String(answer.status)}`);
  }
  const groups = quotaGroups(asRecord(asRecord(answer.command)?.data)?.groups);
  const group = groups.reduce<QuotaGroup | undefined>(
    (tightest, candidate) =>
      !tightest || leastRemaining(candidate) < leastRemaining(tightest) ? candidate : tightest,
    undefined,
  );
  const primary = group && usageWindow(group, "5h");
  const secondary = group && usageWindow(group, "weekly");
  if (!group || (!primary && !secondary)) throw new UsageUnsupportedError();
  const exhausted = group.buckets.some((bucket) => bucket.remaining <= 0);
  return {
    provider: RUNTIME_PROVIDER.ANTIGRAVITY,
    planType: group.name,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    health: exhausted ? "rate_limited" : "ok",
  };
}

function quotaGroups(value: unknown): QuotaGroup[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const group = asRecord(raw);
    if (typeof group?.name !== "string" || !Array.isArray(group.buckets)) return [];
    const buckets = group.buckets.flatMap((rawBucket): QuotaBucket[] => {
      const bucket = asRecord(rawBucket);
      const remaining = bucket?.remaining_fraction;
      if (
        typeof bucket?.id !== "string" ||
        typeof bucket.window !== "string" ||
        typeof remaining !== "number" ||
        !Number.isFinite(remaining)
      )
        return [];
      const resetsAt = instant(bucket.reset_time);
      return [
        { id: bucket.id, window: bucket.window, remaining, ...(resetsAt ? { resetsAt } : {}) },
      ];
    });
    return buckets.length ? [{ name: group.name, buckets }] : [];
  });
}

function leastRemaining(group: QuotaGroup): number {
  return Math.min(...group.buckets.map((bucket) => bucket.remaining));
}

function usageWindow(group: QuotaGroup, window: string): UsageWindow | undefined {
  const bucket = group.buckets.find((candidate) => candidate.window === window);
  const minutes = WINDOW_MINUTES[window];
  if (!bucket || minutes === undefined) return undefined;
  const usedPercent = Math.min(100, Math.max(0, (1 - bucket.remaining) * 100));
  return {
    id: `antigravity-${bucket.id}`,
    usedPercent,
    status: bucket.remaining <= 0 ? "limit_reached" : "ok",
    windowDurationMinutes: minutes,
    ...(bucket.resetsAt ? { resetsAt: bucket.resetsAt } : {}),
  };
}

function instant(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
