import { RefreshCw } from "lucide-react";
import { useState } from "react";

import type { RuntimeProvider } from "@coforge/protocol";
import { formatDateForDisplay } from "@/lib/dates";
import { m } from "@/paraglide/messages";

export type UsageView = {
  status: "available" | "unavailable" | "reauth" | "error" | "unsupported";
  snapshot?: {
    planType?: string;
    primary?: {
      usedPercent?: number;
      status?: "available" | "rate-limited";
      resetsAt: string;
    };
    secondary?: {
      usedPercent?: number;
      status?: "available" | "rate-limited";
      resetsAt: string;
    };
  };
  message?: string;
};

export type Runtime = { provider: RuntimeProvider; version: string; displayName: string };

/** One Code Agent on a Computer, and the usage snapshot a scan brings back. */
export function RuntimeUsage({
  runtime,
  usage,
  timeZone = null,
  onScan,
}: {
  runtime: Runtime;
  usage?: UsageView;
  timeZone?: string | null;
  onScan: () => void;
}) {
  const [scanning, setScanning] = useState(false);
  const unsupported = usage?.status === "unsupported";
  const scan = async () => {
    setScanning(true);
    try {
      await onScan();
    } finally {
      setScanning(false);
    }
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-4 border-b pb-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{runtime.displayName}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {m.computer_runtime_version({ version: runtime.version })}
            {!unsupported && ` · ${m.computer_usage_title()}`}
          </p>
        </div>
        {!unsupported && (
          <button
            type="button"
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
            onClick={() => void scan()}
            disabled={scanning}
          >
            <RefreshCw aria-hidden="true" className={scanning ? "size-3 animate-spin" : "size-3"} />
            {scanning
              ? m.computer_usage_scanning()
              : usage?.snapshot
                ? m.computer_usage_refresh()
                : m.computer_usage_scan()}
          </button>
        )}
      </div>
      {unsupported ? null : !usage ? (
        <div className="mt-3 rounded-md bg-muted/50 px-3 py-4 text-center">
          <p className="font-medium">{m.computer_usage_empty()}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {m.computer_usage_empty_description()}
          </p>
        </div>
      ) : usage.status !== "available" ? (
        <div className="mt-3 rounded-md border border-dashed px-3 py-3">
          <p className="font-medium">{m.computer_usage_unavailable()}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {usageStatusDescription(usage.status)}
          </p>
        </div>
      ) : (
        <div className="mt-3">
          {usage.snapshot?.planType && (
            <span className="inline-flex rounded-md bg-muted px-2 py-1 text-xs font-medium">
              {m.computer_usage_plan_name({ plan: formatPlan(usage.snapshot.planType) })}
            </span>
          )}
          <div className={usage.snapshot?.planType ? "mt-3 grid gap-2" : "grid gap-2"}>
            {(["primary", "secondary"] as const).map((key) => {
              const window = usage.snapshot?.[key];
              if (!window) return null;
              return (
                <UsageWindow
                  key={key}
                  label={key === "primary" ? m.computer_usage_session() : m.computer_usage_weekly()}
                  window={window}
                  timeZone={timeZone}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function usageStatusDescription(status: Exclude<UsageView["status"], "available">): string {
  if (status === "unsupported") return "";
  if (status === "reauth") return m.computer_usage_reauth();
  if (status === "unavailable") return m.computer_usage_unavailable_description();
  return m.computer_usage_error();
}

function UsageWindow({
  label,
  window,
  timeZone,
}: {
  label: string;
  window: NonNullable<NonNullable<UsageView["snapshot"]>["primary"]>;
  timeZone: string | null;
}) {
  const value =
    window.usedPercent === undefined
      ? window.status === "rate-limited"
        ? m.computer_usage_limit_reached()
        : m.computer_usage_available()
      : m.computer_usage_used_percent({ percent: window.usedPercent });

  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="font-medium tabular-nums">{value}</p>
      </div>
      {window.usedPercent !== undefined && (
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={window.usedPercent}
          className="mt-2 h-1 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }}
          />
        </div>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        {m.computer_usage_resets_at({ time: formatDateForDisplay(window.resetsAt, timeZone) })}
      </p>
    </div>
  );
}

/** The provider's own plan name, which CoForge shows as the provider wrote it. */
function formatPlan(plan: string) {
  return plan ? `${plan[0]!.toUpperCase()}${plan.slice(1)}` : plan;
}
