import { RefreshCw01 as RefreshCw } from "@untitledui/icons";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import {
  RUNTIME_PROVIDER,
  RUNTIME_PROVIDER_USES_EXTERNAL_CLI,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { HoverPopover } from "#src/components/ui/hover-popover";
import { RelativeTime } from "#src/components/ui/relative-time";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { RuntimeProviderMark } from "#src/features/agents/runtime-provider-mark";
import { useRuntimeUsage } from "./use-runtime-usage";
import type { UsageReadResult, UsageResultRecord } from "#src/server/centrifugo/usage-cache.server";

export type Runtime = {
  provider: RuntimeProvider;
  /** The CLI's own reported version, when known — e.g. absent for the Agent profile panel until
   * its Computer has reported one. */
  version?: string;
  displayName: string;
};

/** "ok" only when the last read is fresh, available, and no usage window is at its limit. */
export type UsageHealth = "ok" | "attention";

export function RuntimeIdentity({ runtime, health }: { runtime: Runtime; health?: UsageHealth }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <RuntimeProviderMark provider={runtime.provider} className="size-6" />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <span className="block truncate font-medium text-primary">{runtime.displayName}</span>
          <UsageHealthDot health={health} />
        </span>
        {runtime.version && (
          <span className="mt-0.5 block truncate text-xs text-tertiary">{runtime.version}</span>
        )}
      </span>
    </span>
  );
}

/** A small health indicator for a Runtime trigger — reuses the same dot styling the Agent
 * profile panel already draws for a Computer's connected/offline state. */
export function UsageHealthDot({
  health,
  className,
}: {
  health?: UsageHealth;
  className?: string;
}) {
  if (!health) return null;
  return (
    <span
      role="img"
      aria-label={
        health === "ok" ? m.computer_usage_health_ok() : m.computer_usage_health_attention()
      }
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        health === "ok" ? "bg-success-solid" : "bg-warning-solid",
        className,
      )}
    />
  );
}

const DEFAULT_TRIGGER_CLASS_NAME =
  "-m-1 min-w-0 rounded-lg p-1 text-left outline-none hover:bg-primary_hover data-focus-visible:ring-2 data-focus-visible:ring-brand";

/**
 * One Code Agent runtime on a Computer, and the shared provider-usage popover: reads the cached
 * usage on mount, refreshes it with at most one automatic scan when that read is stale or missing
 * and the Computer isn't known offline, and offers a manual Refresh for everything else. A
 * caller without the default `RuntimeIdentity` row (the Agent profile panel's Runtime badge)
 * supplies its own `trigger`, which receives the same health signal `RuntimeIdentity` draws as a
 * dot so both triggers can show it.
 */
export function RuntimeUsage({
  computerId,
  runtime,
  computerOnline,
  timeZone = null,
  trigger,
  triggerClassName,
}: {
  computerId: string;
  runtime: Runtime;
  /** `undefined` means "not known", treated like online for the purpose of auto-scanning. */
  computerOnline?: boolean;
  timeZone?: string | null;
  trigger?: (health: UsageHealth | undefined) => ReactNode;
  triggerClassName?: string;
}) {
  const supportsUsage = RUNTIME_PROVIDER_USES_EXTERNAL_CLI[runtime.provider];
  const usage = useRuntimeUsage(computerId, runtime.provider, {
    enabled: supportsUsage,
    computerOnline,
  });
  const [openCount, setOpenCount] = useState(0);
  const refreshButtonWrapRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (openCount > 0) refreshButtonWrapRef.current?.querySelector("button")?.focus();
  }, [openCount]);

  const health = usageHealth(usage.data);
  const resolvedTrigger = trigger ? (
    trigger(health)
  ) : (
    <RuntimeIdentity runtime={runtime} health={health} />
  );

  if (!supportsUsage) return resolvedTrigger;

  return (
    <HoverPopover
      label={`${runtime.displayName} · ${m.computer_usage_title()}`}
      trigger={resolvedTrigger}
      triggerClassName={triggerClassName ?? DEFAULT_TRIGGER_CLASS_NAME}
      className="p-4 text-sm"
      working={usage.scanning}
      onOpen={() => setOpenCount((count) => count + 1)}
    >
      <RuntimeUsagePopoverContent
        runtime={runtime}
        data={usage.data}
        scanning={usage.scanning}
        scanFailed={usage.scanFailed}
        computerOnline={computerOnline}
        timeZone={timeZone}
        onRefresh={usage.refresh}
        refreshButtonWrapRef={refreshButtonWrapRef}
      />
    </HoverPopover>
  );
}

function usageHealth(data: UsageReadResult | undefined): UsageHealth | undefined {
  if (!data?.result) return undefined;
  const badge = usageBadge(data.result);
  if (!badge) return undefined;
  return badge.color === "success" && data.state === "fresh" ? "ok" : "attention";
}

function usageBadge(
  result: UsageResultRecord,
): { color: "success" | "warning" | "error"; label: string } | undefined {
  if (result.status === "reauth")
    return { color: "warning", label: m.computer_usage_badge_reauth() };
  if (result.status === "unavailable")
    return { color: "error", label: m.computer_usage_badge_unavailable() };
  if (result.status === "error") return { color: "error", label: m.computer_usage_badge_error() };
  if (result.status !== "available") return undefined;
  const rateLimited =
    result.snapshot?.health === "rate_limited" ||
    result.snapshot?.primary?.status === "limit_reached" ||
    result.snapshot?.secondary?.status === "limit_reached";
  return rateLimited
    ? { color: "warning", label: m.computer_usage_limit_reached() }
    : { color: "success", label: m.computer_usage_badge_ok() };
}

function footerStatusText(
  data: UsageReadResult | undefined,
  scanning: boolean,
  computerOnline: boolean | undefined,
  scanFailed: boolean,
): string | undefined {
  if (scanning) return m.computer_usage_scanning();
  if (computerOnline === false) return m.computer_usage_offline();
  if (scanFailed) return m.computer_usage_no_response();
  return usageFailureDescription(data?.result?.status);
}

function usageFailureDescription(status: UsageResultRecord["status"] | undefined) {
  if (status === "reauth") return m.computer_usage_reauth();
  if (status === "unavailable") return m.computer_usage_unavailable_description();
  if (status === "error") return m.computer_usage_error();
  return undefined;
}

/**
 * The popover's pure body: everything `RuntimeUsage` fetches, rendered without touching a query
 * client itself, so a test can render it directly with a plain `data` fixture (see
 * `agent-profile-tab.test.tsx`/the Computer detail tests) instead of standing up React Query.
 */
export function RuntimeUsagePopoverContent({
  runtime,
  data,
  scanning,
  scanFailed = false,
  computerOnline,
  timeZone = null,
  onRefresh,
  refreshButtonWrapRef,
}: {
  runtime: Pick<Runtime, "provider" | "displayName" | "version">;
  data?: UsageReadResult;
  scanning: boolean;
  scanFailed?: boolean;
  computerOnline?: boolean;
  timeZone?: string | null;
  onRefresh: () => void;
  refreshButtonWrapRef?: RefObject<HTMLSpanElement | null>;
}) {
  const snapshot = data?.result?.snapshot;
  const badge = data?.result ? usageBadge(data.result) : undefined;
  const reading = !data || (data.state === "missing" && (scanning || data.pendingScanId));
  const status = footerStatusText(data, scanning, computerOnline, scanFailed);

  return (
    <div>
      <div className="border-b border-secondary pb-3">
        <h2 className="min-w-0 font-medium text-primary">
          {runtime.displayName} · {m.computer_usage_title()}
        </h2>
        {runtime.version && (
          <p className="mt-0.5 text-xs text-tertiary">
            {m.computer_runtime_version({ version: runtime.version })}
          </p>
        )}
        <p className="mt-0.5 text-xs text-tertiary">{m.computer_usage_visibility()}</p>
      </div>

      {reading ? (
        <p className="mt-3 text-tertiary">{m.computer_usage_reading()}</p>
      ) : (
        <>
          {data?.state === "stale" && (
            <p className="mt-3 text-xs text-warning-primary">
              {scanning ? m.computer_usage_stale_refreshing() : m.computer_usage_stale()}
            </p>
          )}
          {snapshot && (
            <div className="mt-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                {snapshot.planType && (
                  <p className="font-medium text-primary">
                    {m.computer_usage_plan_name({ plan: formatPlan(snapshot.planType) })}
                  </p>
                )}
                {snapshot.accountLabel && (
                  <p className="mt-0.5 truncate text-xs text-tertiary">{snapshot.accountLabel}</p>
                )}
              </div>
              {badge && (
                <Badge color={badge.color} size="sm">
                  {badge.label}
                </Badge>
              )}
            </div>
          )}
          {snapshot && (
            <div className="mt-3 divide-y divide-secondary">
              {(["primary", "secondary"] as const).map((key) => {
                const window = snapshot[key];
                if (!window) return null;
                return (
                  <UsageWindow
                    key={key}
                    label={
                      key === "primary"
                        ? runtime.provider === RUNTIME_PROVIDER.KIRO
                          ? m.computer_usage_monthly_credits()
                          : m.computer_usage_session()
                        : m.computer_usage_weekly()
                    }
                    window={window}
                    creditUsage={key === "primary" ? snapshot.creditUsage : undefined}
                    timeZone={timeZone}
                  />
                );
              })}
            </div>
          )}
        </>
      )}

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-secondary pt-3">
        <div className="min-w-0 text-xs text-tertiary">
          {data?.result && (
            <p>
              {m.computer_usage_updated()}{" "}
              <RelativeTime value={data.result.collectedAt} timeZone={timeZone} />
            </p>
          )}
          {status && <p className={data?.result ? "mt-1" : undefined}>{status}</p>}
        </div>
        <span ref={refreshButtonWrapRef} className="shrink-0">
          <Button
            type="button"
            color="secondary"
            size="sm"
            onPress={onRefresh}
            isDisabled={scanning || computerOnline === false}
            isLoading={scanning}
            iconLeading={RefreshCw}
          >
            {m.computer_usage_refresh()}
          </Button>
        </span>
      </div>
    </div>
  );
}

function UsageWindow({
  label,
  window,
  creditUsage,
  timeZone,
}: {
  label: string;
  window: NonNullable<NonNullable<UsageResultRecord["snapshot"]>["primary"]>;
  creditUsage?: NonNullable<UsageResultRecord["snapshot"]>["creditUsage"];
  timeZone: string | null;
}) {
  const value =
    window.usedPercent === undefined
      ? window.status === "parse_unavailable"
        ? m.computer_usage_badge_unavailable()
        : window.status === "limit_reached"
          ? m.computer_usage_limit_reached()
          : m.computer_usage_available()
      : m.computer_usage_used_percent({ percent: window.usedPercent });

  return (
    <div className="py-2 first:pt-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-medium text-primary">{label}</p>
        <p className="shrink-0 text-xs text-tertiary tabular-nums">
          {value}
          {window.resetsAt !== undefined && (
            <>
              {" · "}
              {m.computer_usage_resets()}{" "}
              <RelativeTime value={window.resetsAt} timeZone={timeZone} />
            </>
          )}
        </p>
      </div>
      {creditUsage && (
        <p className="mt-1 text-xs tabular-nums text-tertiary">
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
            className={cn(
              "h-full rounded-full",
              window.status === "limit_reached" ? "bg-warning-solid" : "bg-fg-tertiary",
            )}
            style={{
              width: `${Math.min(100, Math.max(0, window.usedPercent))}%`,
            }}
          />
        </div>
      )}
      {creditUsage && creditUsage.overage > 0 && (
        <p className="mt-2 text-xs tabular-nums text-tertiary">
          {m.computer_usage_credit_overage({ overage: creditUsage.overage })}
        </p>
      )}
    </div>
  );
}

/** The provider's own plan name, which CoForge shows as the provider wrote it. */
function formatPlan(plan: string) {
  return plan ? `${plan[0]!.toUpperCase()}${plan.slice(1)}` : plan;
}
