import type { UsageSnapshot, UsageWindow } from "#src/code-agent/contract";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { maskEmail } from "#src/code-agent/mask-email";
import { claudeCliEnvironment, runClaudeCli as run } from "./process";

export async function readClaudeCodeUsage(
  workingDirectory: string,
  options: {
    command?: readonly string[];
    environment?: Readonly<Record<string, string>>;
    timeoutMs?: number;
  } = {},
): Promise<UsageSnapshot | null> {
  const baseCommand = options.command ?? ["claude"];
  const timeoutMs = options.timeoutMs ?? 5_000;
  const environment = claudeCliEnvironment(options.environment);
  const auth = await run(
    [...baseCommand, "auth", "status", "--json"],
    workingDirectory,
    environment,
    timeoutMs,
  );
  if (auth.timedOut) throw new ClaudeUsageTimeoutError();
  if (auth.exitCode !== 0 || !loggedIn(auth.stdout)) return null;
  const usage = await run(
    [...baseCommand, "-p", "/usage", "--output-format", "json"],
    workingDirectory,
    environment,
    timeoutMs,
  );
  if (usage.timedOut) throw new ClaudeUsageTimeoutError();
  if (usage.exitCode !== 0) return null;
  const snapshot = parseUsage(usage.stdout);
  return snapshot ? { ...snapshot, ...account(auth.stdout) } : null;
}

export class ClaudeUsageTimeoutError extends Error {
  constructor() {
    super("Claude Code usage request timed out");
  }
}

function loggedIn(output: string): boolean {
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    return value.loggedIn === true || value.isLoggedIn === true || value.authenticated === true;
  } catch {
    return false;
  }
}

/** The plan and the signed-in address the sign-in report already carries. The address is masked
 * here so the full one never leaves this Computer. */
function account(output: string): Pick<UsageSnapshot, "planType" | "accountLabel"> {
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    const accountLabel = typeof value.email === "string" ? maskEmail(value.email) : undefined;
    return {
      ...(typeof value.subscriptionType === "string" && value.subscriptionType
        ? { planType: value.subscriptionType }
        : {}),
      ...(accountLabel ? { accountLabel } : {}),
    };
  } catch {
    return {};
  }
}

function parseUsage(output: string): UsageSnapshot | null {
  let text = output;
  try {
    const value = JSON.parse(output) as unknown;
    if (typeof value === "string") text = value;
    else if (value && typeof value === "object") {
      if ("result" in value && typeof value.result === "string") text = value.result;
      else if ("text" in value && typeof value.text === "string") text = value.text;
      else return null;
    } else return null;
  } catch {
    /* Some Claude versions emit the report as plain text. */
  }
  const primary = window(
    text,
    /^Current session:?\s+([\d.]+)%[^\r\n]{0,100}?(?:reset|resets)[^\r\n]{0,40}?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:,\s+(\d{4}),|\s+at)\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(UTC\)/im,
  );
  const secondary = window(
    text,
    /^Current week(?: \(all models\))?:?\s+([\d.]+)%[^\r\n]{0,100}?(?:reset|resets)[^\r\n]{0,40}?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:,\s+(\d{4}),|\s+at)\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(UTC\)/im,
  );
  if (!primary && !secondary) return null;
  return {
    provider: RUNTIME_PROVIDER.CLAUDE_CODE,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

function window(text: string, pattern: RegExp): UsageWindow | undefined {
  const match = text.match(pattern);
  if (!match) return undefined;
  const usedPercent = Number(match[1]);
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ].indexOf(match[2] ?? "");
  let hour = Number(match[5]);
  if ((match[7] ?? "").toLowerCase() === "pm" && hour !== 12) hour += 12;
  if ((match[7] ?? "").toLowerCase() === "am" && hour === 12) hour = 0;
  const now = new Date();
  let year = match[4] ? Number(match[4]) : now.getUTCFullYear();
  // Session/week resets are near the scan date, including just-expired windows.
  // Infer the adjacent year around New Year without moving stale resets a year ahead.
  if (!match[4]) {
    if (month - now.getUTCMonth() < -6) year += 1;
    if (month - now.getUTCMonth() > 6) year -= 1;
  }
  const reset = new Date(Date.UTC(year, month, Number(match[3]), hour, Number(match[6])));
  if (!Number.isFinite(usedPercent) || month < 0 || Number.isNaN(reset.getTime())) return undefined;
  return {
    usedPercent,
    windowDurationMinutes: Math.max(0, Math.round((reset.getTime() - Date.now()) / 60_000)),
    resetsAt: reset.toISOString(),
  };
}
