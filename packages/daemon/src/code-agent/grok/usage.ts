import { client, type AnyMessage } from "@agentclientprotocol/sdk";
import type { UsageSnapshot, UsageWindow } from "#src/code-agent/contract";
import { UsageUnavailableError, UsageUnsupportedError } from "#src/code-agent/contract";
import { agentEnvironment } from "#src/code-agent/environment";
import { JsonlProcess, JsonlRequestError } from "#src/code-agent/jsonl-process";
import { asRecord } from "#src/code-agent/json-record";
import { maskEmail } from "#src/code-agent/mask-email";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

/** Reads Grok's account billing endpoint through its ACP surface (Raft's account-usage reader). */
export async function readGrokUsage(
  workingDirectory: string,
  options: {
    command?: readonly string[];
    environment?: Readonly<Record<string, string>>;
    timeoutMs?: number;
  } = {},
): Promise<UsageSnapshot | null> {
  const process = new JsonlProcess(
    [...(options.command ?? ["grok"]), "agent", "--always-approve", "--no-leader", "stdio"],
    workingDirectory,
    agentEnvironment(options.environment),
  );
  const timeoutMs = options.timeoutMs ?? 10_000;
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      process.onRecord((record) => controller.enqueue(record as AnyMessage));
    },
    cancel() {},
  });
  const connection = client({ name: "coforge-daemon-usage" }).connect({
    readable,
    writable: new WritableStream<AnyMessage>({ write: (message) => process.send(message) }),
  });
  try {
    const initialized = await bounded(
      connection.agent.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "coforge-daemon-usage", version: "0.1.0" },
        _meta: { cwd: workingDirectory },
      }),
      timeoutMs,
    );
    const method = initialized.authMethods?.[0]?.id;
    if (method) await bounded(connection.agent.request("authenticate", { methodId: method }), timeoutMs);
    const billing = await bounded(connection.agent.request("_x.ai/billing", {}), timeoutMs);
    let email: string | undefined;
    try {
      const auth = await bounded(connection.agent.request("_x.ai/auth/info", {}), timeoutMs);
      const value = asRecord(auth)?.email;
      if (typeof value === "string") email = maskEmail(value);
    } catch {
      // Billing is useful without exposing an account label.
    }
    return projectBilling(billing, email);
  } catch (error) {
    if (error instanceof JsonlRequestError) {
      const rpc = asRecord(error.responseError);
      const code = typeof rpc?.code === "number" ? rpc.code : undefined;
      const message = typeof rpc?.message === "string" ? rpc.message : "";
      if (code === -32601) throw new UsageUnsupportedError();
      if (code === -32000 || /auth(?:entication)?|log(?:ged)? ?in/iu.test(message))
        throw new UsageUnavailableError();
    }
    throw error;
  } finally {
    connection.close();
    await process.dispose().catch(() => undefined);
  }
}

function projectBilling(value: unknown, accountLabel?: string): UsageSnapshot {
  const root = asRecord(value);
  const config = asRecord(root?.config);
  if (!config) throw new UsageUnsupportedError();
  const explicit = number(config.creditUsagePercent);
  const used = cents(config.used);
  const limit = cents(config.monthlyLimit);
  const percent = explicit ?? (used !== undefined && limit !== undefined && limit > 0 ? (used / limit) * 100 : undefined);
  if (percent === undefined || percent < 0) throw new Error("Grok returned no usable account usage percentage");
  const period = asRecord(config.currentPeriod);
  const reset = instant(period?.end ?? config.billingPeriodEnd);
  const primary = window(periodLabel(period?.type), percent, reset, 43200);
  const cap = cents(config.onDemandCap);
  const over = cents(config.onDemandUsed) ?? (used !== undefined && limit !== undefined ? Math.max(0, used - limit) : 0);
  const secondary = cap !== undefined && cap > 0 ? window("Pay-as-you-go", (over / cap) * 100, reset, 43200) : undefined;
  const rateLimited = percent >= 100 && (secondary === undefined || (secondary.usedPercent ?? 0) >= 100);
  return { provider: RUNTIME_PROVIDER.GROK, primary, ...(secondary ? { secondary } : {}), ...(typeof root?.subscription_tier === "string" ? { planType: root.subscription_tier } : {}), ...(accountLabel ? { accountLabel } : {}), health: rateLimited ? "rate_limited" : "ok" };
}

function window(label: string, percent: number, resetsAt: string | undefined, minutes: number): UsageWindow {
  return { id: `grok-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, usedPercent: Math.min(100, percent), status: percent >= 100 ? "limit_reached" : "ok", windowDurationMinutes: minutes, ...(resetsAt ? { resetsAt } : {}) };
}
function periodLabel(value: unknown): string { return typeof value === "string" && value.trim() ? value.trim() : "Monthly"; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function cents(value: unknown): number | undefined { const n = number(value); return n === undefined ? undefined : n; }
function instant(value: unknown): string | undefined { const date = new Date(typeof value === "number" ? value * 1000 : String(value ?? "")); return Number.isNaN(date.getTime()) ? undefined : date.toISOString(); }
async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Grok usage request timed out")), timeoutMs); })]); } finally { clearTimeout(timer); } }
