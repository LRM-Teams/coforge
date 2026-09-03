import type { UsageSnapshot, UsageWindow } from "../contract";
import { agentEnvironment } from "../environment";
import { RUNTIME_PROVIDER } from "@coforge/protocol";

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
  const environment = agentEnvironment(options.environment);
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
  return parseUsage(usage.stdout);
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

function parseUsage(output: string): UsageSnapshot | null {
  let text = output;
  try {
    const value = JSON.parse(output) as unknown;
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    /* Some Claude versions emit the report as plain text. */
  }
  const primary = window(
    text,
    /Current session[\s\S]{0,180}?([\d.]+)%[\s\S]{0,100}?(?:reset|resets)[\s\S]{0,40}?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(UTC\)/i,
  );
  const secondary = window(
    text,
    /Current week[\s\S]{0,180}?([\d.]+)%[\s\S]{0,100}?(?:reset|resets)[\s\S]{0,40}?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(UTC\)/i,
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
  const reset = new Date(
    Date.UTC(Number(match[4]), month, Number(match[3]), hour, Number(match[6])),
  );
  if (!Number.isFinite(usedPercent) || month < 0 || Number.isNaN(reset.getTime())) return undefined;
  return {
    usedPercent,
    windowDurationMinutes: Math.max(0, Math.round((reset.getTime() - Date.now()) / 60_000)),
    resetsAt: reset.toISOString(),
  };
}

async function run(
  cmd: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
) {
  const child = Bun.spawn({ cmd: [...cmd], cwd, env, stdout: "pipe", stderr: "ignore" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.all([new Response(child.stdout).text(), child.exited]).then(([stdout, exitCode]) => ({
        stdout,
        exitCode,
        timedOut: false,
      })),
      new Promise<{ stdout: string; exitCode: number; timedOut: true }>((resolve) => {
        timer = setTimeout(() => {
          child.kill();
          resolve({ stdout: "", exitCode: -1, timedOut: true });
        }, timeoutMs);
      }),
    ]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    child.kill();
  }
}
