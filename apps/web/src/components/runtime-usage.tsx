import { ChevronRight, RefreshCw } from "lucide-react";
import { useState } from "react";

import type { RuntimeProvider } from "@coforge/protocol";
import { Popover } from "@base-ui/react/popover";

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

export function RuntimeUsage({
  runtime,
  usage,
  onScan,
}: {
  runtime: Runtime;
  usage?: UsageView;
  onScan: () => void;
}) {
  const [scanning, setScanning] = useState(false);
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
          <p className="mt-0.5 text-xs text-muted-foreground">Version {runtime.version} · Usage</p>
        </div>
        <button
          type="button"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
          onClick={() => void scan()}
          disabled={scanning}
        >
          <RefreshCw className={scanning ? "size-3 animate-spin" : "size-3"} />
          {scanning ? "Scanning…" : usage?.snapshot ? "Refresh" : "Scan"}
        </button>
      </div>
      {!usage ? (
        <div className="mt-3 rounded-md bg-muted/50 px-3 py-4 text-center">
          <p className="font-medium">No snapshot yet</p>
          <p className="mt-1 text-xs text-muted-foreground">Scan to load current usage limits.</p>
        </div>
      ) : usage.status !== "available" ? (
        <div className="mt-3 rounded-md border border-dashed px-3 py-3">
          <p className="font-medium">Usage unavailable</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {usage.message ?? `Usage ${usage.status}`}
          </p>
        </div>
      ) : (
        <div className="mt-3">
          {usage.snapshot?.planType && (
            <span className="inline-flex rounded-md bg-muted px-2 py-1 text-xs font-medium">
              {formatPlan(usage.snapshot.planType)} plan
            </span>
          )}
          <div className={usage.snapshot?.planType ? "mt-3 grid gap-2" : "grid gap-2"}>
            {(["primary", "secondary"] as const).map((key) => {
              const window = usage.snapshot?.[key];
              if (!window) return null;
              return (
                <UsageWindow
                  key={key}
                  label={key === "primary" ? "Session" : "Weekly"}
                  window={window}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function UsageWindow({
  label,
  window,
}: {
  label: string;
  window: NonNullable<NonNullable<UsageView["snapshot"]>["primary"]>;
}) {
  const value =
    window.usedPercent === undefined
      ? window.status === "rate-limited"
        ? "Limit reached"
        : "Available"
      : `${window.usedPercent}% used`;
  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="font-medium tabular-nums">{value}</p>
      </div>
      {window.usedPercent !== undefined && (
        <div
          role="progressbar"
          aria-label={`${label} usage`}
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
      <p className="mt-2 text-xs text-muted-foreground">Resets {formatReset(window.resetsAt)}</p>
    </div>
  );
}

function formatPlan(plan: string) {
  return plan ? `${plan[0]!.toUpperCase()}${plan.slice(1)}` : plan;
}

function formatReset(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function RuntimePopover({
  runtime,
  usage,
  onScan,
}: {
  runtime: Runtime;
  usage?: UsageView;
  onScan: () => void;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger className="group flex w-full items-center justify-between gap-4 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring">
        <span className="min-w-0">
          <span className="block truncate font-medium">{runtime.displayName}</span>
          <span className="block text-xs text-muted-foreground">Version {runtime.version}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
          Usage
          <ChevronRight aria-hidden="true" className="size-3.5" />
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={8} className="z-50">
          <Popover.Popup className="w-[min(22rem,calc(100vw-2rem))] rounded-lg border bg-popover p-4 text-sm text-popover-foreground shadow-lg outline-none">
            <RuntimeUsage runtime={runtime} usage={usage} onScan={onScan} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
