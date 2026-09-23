import { createHash } from "node:crypto";
import type { UsageSnapshot, UsageWindow } from "#src/code-agent/contract";
import { UsageUnavailableError, UsageUnsupportedError } from "#src/code-agent/contract";
import { agentEnvironment } from "#src/code-agent/environment";
import { asRecord } from "#src/code-agent/json-record";
import { maskEmail } from "#src/code-agent/mask-email";
import { JsonlProcess } from "#src/code-agent/jsonl-process";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

/** Ported from Raft 1.0.32's Codex account-usage reader (`@botiverse/oar` codex/account-usage):
 * the usage reader talks to the app-server with the experimental API, reads the signed-in
 * account before the rate limits, reports only a masked label, and treats a non-subscription
 * account (API-key / Bedrock / `requiresOpenaiAuth === false`) as having no plan usage at all. */
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
          capabilities: { experimentalApi: true },
        },
      }),
      timeoutMs,
    );
    await process.send({ method: "initialized", params: {} });
    // Best-effort: an app-server that predates `account/read` (or any account failure) still
    // scans, just without the account label — Raft swallows every `account/read` error too.
    let account: Record<string, unknown> | undefined;
    try {
      const response = await withTimeout(
        process.request({ method: "account/read", params: {} }),
        timeoutMs,
      );
      account = asRecord(response.result);
    } catch {
      /* The scan continues without the account. */
    }
    if (isNonSubscription(account)) throw new UsageUnsupportedError();
    const response = await withTimeout(
      process.request({ method: "account/rateLimits/read", params: {} }),
      timeoutMs,
    );
    return toSnapshot(response, account);
  } catch (error) {
    if (
      error instanceof UsageTimeoutError ||
      error instanceof UsageUnsupportedError ||
      error instanceof UsageUnavailableError
    )
      throw error;
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

/** Raft's `isNonSubscriptionAccount`: an API-key or Bedrock account, or one with OpenAI auth
 * disabled, has no plan windows — the scan answers `unsupported` instead of an empty reading. */
function isNonSubscription(account: Record<string, unknown> | undefined): boolean {
  const type = asRecord(account?.account)?.type;
  return type === "apiKey" || type === "amazonBedrock" || account?.requiresOpenaiAuth === false;
}

function toSnapshot(
  response: Readonly<Record<string, unknown>>,
  account: Record<string, unknown> | undefined,
): UsageSnapshot | null {
  const result = asRecord(response.result);
  const nestedLimits = asRecord(result?.rateLimits);
  const limits = nestedLimits ? { ...result, ...nestedLimits } : result;
  if (!limits) return null;
  const primary = toWindow(limits, "primary", 0);
  const secondary = toWindow(limits, "secondary", 1);
  const credits = asRecord(limits.credits);
  const hasCredits =
    credits && typeof credits.hasCredits === "boolean" && typeof credits.unlimited === "boolean";
  if (!primary && !secondary) {
    // Raft's reader errors when a signed-in subscription account yields no usable window;
    // without an account (an app-server predating `account/read`) keep the old `null` answer
    // unless the reading still carries plan or credits information.
    if (account) throw new UsageUnavailableError();
    if (!hasCredits && typeof limits.planType !== "string") return null;
  }
  const rateLimited =
    (limits.rateLimitReachedType !== null && limits.rateLimitReachedType !== undefined) ||
    primary?.status === "limit_reached" ||
    secondary?.status === "limit_reached";
  const accountRecord = asRecord(account?.account);
  const email =
    accountRecord?.type === "chatgpt" && typeof accountRecord.email === "string"
      ? maskEmail(accountRecord.email)
      : undefined;
  return {
    provider: RUNTIME_PROVIDER.CODEX,
    ...(typeof limits.planType === "string" ? { planType: limits.planType } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(hasCredits
      ? {
          credits: {
            hasCredits: credits!.hasCredits as boolean,
            unlimited: credits!.unlimited as boolean,
          },
        }
      : {}),
    ...(email ? { accountLabel: email } : {}),
    health: rateLimited ? "rate_limited" : "ok",
  };
}

/** Raft's `limitLabel`: the bucket's own name, else its `limitId` (`codex` renders as the
 * provider name), else the plain provider name. */
function limitLabel(limits: Record<string, unknown>): string {
  const name = label(limits.limitName);
  if (name !== undefined) return name;
  const id = label(limits.limitId);
  return id === "codex" || id === undefined ? "Codex" : id;
}

function label(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 80 ? trimmed : undefined;
}

/** Raft's `windowLabel`: a readable duration like `5 hours` / `1 week` / `90 minutes`. */
function durationLabel(mins: number): string {
  if (mins % (7 * 24 * 60) === 0) {
    const weeks = mins / (7 * 24 * 60);
    return `${weeks} ${weeks === 1 ? "week" : "weeks"}`;
  }
  if (mins % (24 * 60) === 0) {
    const days = mins / (24 * 60);
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (mins % 60 === 0) {
    const hours = mins / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${mins} minutes`;
}

/** Raft's `windowId`: `w<index>_<first 12 hex of sha256(label)>`, stable for a stable label. */
function windowId(label: string, index: number): string {
  return `w${index}_${createHash("sha256").update(label).digest("hex").slice(0, 12)}`;
}

function toWindow(
  limits: Record<string, unknown>,
  kind: "primary" | "secondary",
  index: number,
): UsageWindow | undefined {
  const item = asRecord(limits[kind]);
  if (!item || typeof item.windowDurationMins !== "number" || item.windowDurationMins <= 0)
    return undefined;
  const id = windowId(`${limitLabel(limits)} · ${durationLabel(item.windowDurationMins)}`, index);
  if (typeof item.usedPercent !== "number" || !Number.isFinite(item.usedPercent)) {
    // The window exists but its ratio is unreadable — report it as `parse_unavailable` with
    // both the ratio and the reset omitted, like Raft's projection does.
    return { id, status: "parse_unavailable", windowDurationMinutes: item.windowDurationMins };
  }
  if (item.usedPercent < 0 || item.usedPercent > 100) return undefined;
  const resetsAt = toResetsAt(item.resetsAt);
  return {
    id,
    usedPercent: item.usedPercent,
    status: item.usedPercent >= 100 ? "limit_reached" : "ok",
    windowDurationMinutes: item.windowDurationMins,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function toResetsAt(value: unknown): string | undefined {
  const reset = typeof value === "number" ? new Date(value * 1000) : new Date(String(value ?? ""));
  return Number.isNaN(reset.getTime()) ? undefined : reset.toISOString();
}
