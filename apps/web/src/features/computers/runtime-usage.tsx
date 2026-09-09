import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { Popover } from "@base-ui/react/popover";
import claudeCodeMark from "@lobehub/icons-static-svg/icons/claudecode-color.svg";
import codexMark from "@lobehub/icons-static-svg/icons/codex.svg";
import piMark from "@lobehub/icons-static-svg/icons/pi.svg";

import type { RuntimeProvider } from "@coforge/protocol";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
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

export type Runtime = {
  provider: RuntimeProvider;
  version: string;
  displayName: string;
};

const runtimeMarks = {
  "claude-code": claudeCodeMark,
  codex: codexMark,
  pi: piMark,
  coforge: "/logo.svg",
} satisfies Record<RuntimeProvider, string>;

export function RuntimeIdentity({ runtime }: { runtime: Runtime }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      {runtime.provider === "claude-code" || runtime.provider === "coforge" ? (
        <img src={runtimeMarks[runtime.provider]} alt="" className="size-6 shrink-0" />
      ) : (
        <span
          aria-hidden="true"
          className="size-6 shrink-0 bg-foreground mask-contain mask-center mask-no-repeat"
          style={{ maskImage: `url("${runtimeMarks[runtime.provider]}")` }}
        />
      )}
      <span className="min-w-0">
        <span className="block truncate font-medium">{runtime.displayName}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {m.computer_runtime_version({ version: runtime.version })}
        </span>
      </span>
    </span>
  );
}

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
  const unsupported =
    runtime.provider === "pi" || runtime.provider === "coforge" || usage?.status === "unsupported";
  const scan = async () => {
    setScanning(true);
    try {
      await onScan();
    } finally {
      setScanning(false);
    }
  };

  if (unsupported) return <RuntimeIdentity runtime={runtime} />;

  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={250}
        closeDelay={200}
        aria-label={`${runtime.displayName} · ${m.computer_usage_title()}`}
        className="-m-1 min-w-0 rounded-lg p-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <RuntimeIdentity runtime={runtime} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={12}
          collisionPadding={12}
          className="z-50"
        >
          <Popover.Popup className="max-h-(--available-height) w-80 max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border bg-popover p-4 text-sm text-popover-foreground shadow-lg outline-none">
            <div className="flex items-center justify-between gap-3 border-b pb-3">
              <Popover.Title className="min-w-0 font-medium">
                {runtime.displayName} · {m.computer_usage_title()}
              </Popover.Title>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void scan()}
                disabled={scanning}
              >
                <RefreshCw
                  aria-hidden="true"
                  className={scanning ? "size-3 animate-spin" : "size-3"}
                />
                {scanning
                  ? m.computer_usage_scanning()
                  : usage?.snapshot
                    ? m.computer_usage_refresh()
                    : m.computer_usage_scan()}
              </Button>
            </div>
            {!usage ? (
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
                    {m.computer_usage_plan_name({
                      plan: formatPlan(usage.snapshot.planType),
                    })}
                  </span>
                )}
                <div className={usage.snapshot?.planType ? "mt-3 grid gap-2" : "grid gap-2"}>
                  {(["primary", "secondary"] as const).map((key) => {
                    const window = usage.snapshot?.[key];
                    if (!window) return null;
                    return (
                      <UsageWindow
                        key={key}
                        label={
                          key === "primary" ? m.computer_usage_session() : m.computer_usage_weekly()
                        }
                        window={window}
                        timeZone={timeZone}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
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
            style={{
              width: `${Math.min(100, Math.max(0, window.usedPercent))}%`,
            }}
          />
        </div>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        {m.computer_usage_resets()} <RelativeTime value={window.resetsAt} timeZone={timeZone} />
      </p>
    </div>
  );
}

/** The provider's own plan name, which CoForge shows as the provider wrote it. */
function formatPlan(plan: string) {
  return plan ? `${plan[0]!.toUpperCase()}${plan.slice(1)}` : plan;
}
