import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import type { UsageSnapshot } from "../contract";
import { UsageUnavailableError } from "../contract";
import { record } from "./connection";

// Kiro's private CLI store/API, also consumed by CodexBar. Never refresh or
// migrate this store. Unknown identities and schemas fail closed.
export async function readKiroUsage(
  options: {
    environment?: Readonly<Record<string, string | undefined>>;
    platform?: NodeJS.Platform;
    timeoutMs?: number;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
  } = {},
): Promise<UsageSnapshot | null> {
  const environment = options.environment ?? Bun.env;
  const home = environment.HOME ?? homedir();
  const expand = (value: string | undefined) => {
    const path = value?.trim();
    return path?.startsWith("~/") ? join(home, path.slice(2)) : path;
  };
  const root =
    expand(environment.KIRO_DATA_DIR) ||
    ((options.platform ?? process.platform) === "darwin"
      ? join(home, "Library/Application Support/kiro-cli")
      : join(expand(environment.XDG_DATA_HOME) || join(home, ".local/share"), "kiro-cli"));
  if (!isAbsolute(root)) return null;
  const path = join(root, "data.sqlite3");
  if (!(await Bun.file(path).exists())) return null;
  let db: Database | undefined;
  let token: Record<string, unknown> | undefined;
  let profile: Record<string, unknown> | undefined;
  try {
    db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 250; BEGIN");
    const authRow = db
      .query<{ value: string }, []>("SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'")
      .get();
    const profileRow = db
      .query<{ value: string }, []>(
        "SELECT value FROM state WHERE key = 'api.codewhisperer.profile'",
      )
      .get();
    token = record(JSON.parse(authRow?.value ?? "null"));
    profile = record(JSON.parse(profileRow?.value ?? "null"));
    db.exec("COMMIT");
  } catch {
    return null;
  } finally {
    db?.close();
  }
  if (typeof token?.access_token !== "string" || !token.access_token.trim()) return null;
  if (
    token.expires_at !== undefined &&
    (typeof token.expires_at !== "string" ||
      !Number.isFinite(Date.parse(token.expires_at)) ||
      Date.parse(token.expires_at) <= Date.now())
  )
    return null;
  const arn = profile?.arn;
  // Reject control characters in native profile data before constructing auth headers.
  // oxlint-disable-next-line no-control-regex
  if (typeof arn !== "string" || /\s|[\u0000-\u001f\u007f]/u.test(arn)) return null;
  const match = /^arn:aws:codewhisperer:(us-east-1|eu-central-1):[0-9]{12}:profile\/.+$/.exec(arn);
  if (!match) return null;
  const endpoint =
    match[1] === "us-east-1"
      ? "https://codewhisperer.us-east-1.amazonaws.com/"
      : "https://q.eu-central-1.amazonaws.com/";
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": "AmazonCodeWhispererService.GetUsageLimits",
      },
      body: JSON.stringify({ profileArn: arn }),
    });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new Error("Kiro usage unavailable");
    const result = snapshot(await response.json());
    if (!result) throw new UsageUnavailableError();
    return result;
  } catch (error) {
    if (error instanceof UsageUnavailableError) throw error;
    // Transport errors may include request headers or local paths.
    throw new Error("Kiro usage request failed");
  }
}

function snapshot(value: unknown): UsageSnapshot | null {
  const data = record(value);
  if (!Array.isArray(data?.usageBreakdownList)) return null;
  const credits = data.usageBreakdownList
    .map(record)
    .filter((item) => item?.resourceType === "CREDIT");
  if (credits.length !== 1) return null;
  const credit = credits[0]!;
  const total = credit.currentUsageWithPrecision;
  const limit = credit.usageLimitWithPrecision;
  const overage = credit.currentOveragesWithPrecision ?? 0;
  const reset = credit.nextDateReset ?? data.nextDateReset;
  if (
    !nonnegative(total) ||
    !nonnegative(limit) ||
    limit === 0 ||
    !nonnegative(overage) ||
    total < overage
  )
    return null;
  // Do not present inseparable trial/bonus credits as a plan-only percentage.
  if (
    (credit.bonuses !== undefined &&
      (!Array.isArray(credit.bonuses) || credit.bonuses.length > 0)) ||
    record(credit.freeTrialInfo)?.freeTrialStatus === "ACTIVE"
  )
    return null;
  const used = total - overage;
  if (
    used > limit ||
    typeof reset !== "number" ||
    !Number.isFinite(reset) ||
    reset < 1_000_000_000 ||
    reset > 4_102_444_800
  )
    return null;
  const date = new Date(reset * 1000);
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1);
  const monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const title = record(data.subscriptionInfo)?.subscriptionTitle;
  return {
    provider: "kiro",
    ...(typeof title === "string" && title.trim() ? { planType: title } : {}),
    creditUsage: { used, limit, overage },
    primary: {
      usedPercent: Math.round((used / limit) * 10_000) / 100,
      windowDurationMinutes: (monthEnd - monthStart) / 60_000,
      resetsAt: date.toISOString(),
    },
  };
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
