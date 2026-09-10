import { RefreshCw01 as RefreshCw } from "@untitledui/icons";
import { useEffect, useRef, useState } from "react";
import claudeCodeMark from "@lobehub/icons-static-svg/icons/claudecode-color.svg";
import codexMark from "@lobehub/icons-static-svg/icons/codex-color.svg";
import piMark from "@lobehub/icons-static-svg/icons/pi.svg";

import type { RuntimeProvider } from "@coforge/protocol";
import { Button } from "@/components/base/buttons/button";
import { HoverPopover } from "@/components/ui/hover-popover";
import { RelativeTime } from "@/components/ui/relative-time";
import { m } from "@/paraglide/messages";

export type UsageView = {
  status: "available" | "unavailable" | "reauth" | "error" | "unsupported";
  snapshot?: {
    planType?: string;
    creditUsage?: { used: number; limit: number; overage: number };
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
} satisfies Partial<Record<RuntimeProvider, string>>;

export function RuntimeIdentity({ runtime }: { runtime: Runtime }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      {runtime.provider === "kiro" ? (
        <span
          aria-hidden="true"
          className="flex size-6 shrink-0 items-center justify-center rounded-md bg-brand-solid text-sm font-semibold text-white"
        >
          K
        </span>
      ) : runtime.provider === "claude-code" ||
        runtime.provider === "codex" ||
        runtime.provider === "coforge" ? (
        <img src={runtimeMarks[runtime.provider]} alt="" className="size-6 shrink-0" />
      ) : (
        <span
          aria-hidden="true"
          className="size-6 shrink-0 bg-fg-primary mask-contain mask-center mask-no-repeat"
          style={{
            maskImage: `url("${runtimeMarks[runtime.provider]}")`,
            WebkitMaskImage: `url("${runtimeMarks[runtime.provider]}")`,
          }}
        />
      )}
      <span className="min-w-0">
        <span className="block truncate font-medium text-primary">{runtime.displayName}</span>
        <span className="mt-0.5 block truncate font-mono text-xs text-tertiary">
          {runtime.version}
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
  const [openCount, setOpenCount] = useState(0);
  const scanButtonWrapRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (openCount > 0) scanButtonWrapRef.current?.querySelector("button")?.focus();
  }, [openCount]);
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
    <HoverPopover
      label={`${runtime.displayName} · ${m.computer_usage_title()}`}
      trigger={<RuntimeIdentity runtime={runtime} />}
      triggerClassName="-m-1 min-w-0 rounded-lg p-1 text-left outline-none hover:bg-primary_hover data-focus-visible:ring-2 data-focus-visible:ring-brand"
      className="p-4 text-sm"
      working={scanning}
      onOpen={() => setOpenCount((count) => count + 1)}
    >
      <div className="flex items-center justify-between gap-3 border-b border-secondary pb-3">
        <h2 className="min-w-0 font-medium text-primary">
          {runtime.displayName} · {m.computer_usage_title()}
        </h2>
        <span ref={scanButtonWrapRef}>
          <Button
            type="button"
            color="secondary"
            size="sm"
            onPress={() => void scan()}
            isDisabled={scanning}
            iconLeading={RefreshCw}
          >
            {scanning
              ? m.computer_usage_scanning()
              : usage?.snapshot
                ? m.computer_usage_refresh()
                : m.computer_usage_scan()}
          </Button>
        </span>
      </div>
      {!usage ? (
        <div className="mt-3 rounded-md bg-secondary px-3 py-4 text-center">
          <p className="font-medium text-primary">{m.computer_usage_empty()}</p>
          <p className="mt-1 text-xs text-tertiary">{m.computer_usage_empty_description()}</p>
        </div>
      ) : usage.status !== "available" ? (
        <div className="mt-3 rounded-md border border-dashed border-secondary px-3 py-3">
          <p className="font-medium text-primary">{m.computer_usage_unavailable()}</p>
          <p className="mt-1 text-xs leading-5 text-tertiary">
            {usageStatusDescription(usage.status)}
          </p>
        </div>
      ) : (
        <div className="mt-3">
          {usage.snapshot?.planType && (
            <span className="inline-flex rounded-md bg-secondary px-2 py-1 text-xs font-medium text-primary">
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
                    key === "primary"
                      ? runtime.provider === "kiro"
                        ? m.computer_usage_monthly_credits()
                        : m.computer_usage_session()
                      : m.computer_usage_weekly()
                  }
                  window={window}
                  creditUsage={key === "primary" ? usage.snapshot?.creditUsage : undefined}
                  timeZone={timeZone}
                />
              );
            })}
          </div>
        </div>
      )}
    </HoverPopover>
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
  creditUsage,
  timeZone,
}: {
  label: string;
  window: NonNullable<NonNullable<UsageView["snapshot"]>["primary"]>;
  creditUsage?: NonNullable<UsageView["snapshot"]>["creditUsage"];
  timeZone: string | null;
}) {
  const value =
    window.usedPercent === undefined
      ? window.status === "rate-limited"
        ? m.computer_usage_limit_reached()
        : m.computer_usage_available()
      : m.computer_usage_used_percent({ percent: window.usedPercent });

  return (
    <div className="rounded-md border border-secondary px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium text-tertiary">{label}</p>
        <p
          className={
            creditUsage
              ? "text-xs text-tertiary tabular-nums"
              : "font-medium text-primary tabular-nums"
          }
        >
          {value}
        </p>
      </div>
      {creditUsage && (
        <p className="mt-2 font-medium tabular-nums">
          {m.computer_usage_credit_amounts({ used: creditUsage.used, limit: creditUsage.limit })}
        </p>
      )}
      {window.usedPercent !== undefined && (
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={window.usedPercent}
          className="mt-2 h-1 overflow-hidden rounded-full bg-secondary"
        >
          <div
            className="h-full rounded-full bg-brand-solid"
            style={{
              width: `${Math.min(100, Math.max(0, window.usedPercent))}%`,
            }}
          />
        </div>
      )}
      {creditUsage && creditUsage.overage > 0 && (
        <p className="mt-2 text-xs tabular-nums">
          {m.computer_usage_credit_overage({ overage: creditUsage.overage })}
        </p>
      )}
      <p className="mt-2 text-xs text-tertiary">
        {m.computer_usage_resets()} <RelativeTime value={window.resetsAt} timeZone={timeZone} />
      </p>
    </div>
  );
}

/** The provider's own plan name, which CoForge shows as the provider wrote it. */
function formatPlan(plan: string) {
  return plan ? `${plan[0]!.toUpperCase()}${plan.slice(1)}` : plan;
}
