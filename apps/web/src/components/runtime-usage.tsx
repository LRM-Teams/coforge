import { RefreshCw } from "lucide-react";
import { useState } from "react";

import type { RuntimeProvider } from "@coforge/protocol";
import { Popover } from "@base-ui/react/popover";

export type UsageView = {
  status: "available" | "unavailable" | "reauth" | "error" | "unsupported";
  snapshot?: {
    planType?: string;
    primary?: { usedPercent: number; resetsAt: string };
    secondary?: { usedPercent: number; resetsAt: string };
  };
  message?: string;
};

export function RuntimeUsage({ usage, onScan }: { usage?: UsageView; onScan: () => void }) {
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
    <div className="border-t pt-1.5">
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium">Usage</p>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs underline"
          onClick={() => void scan()}
          disabled={scanning}
        >
          <RefreshCw className={scanning ? "size-3 animate-spin" : "size-3"} />
          {scanning ? "Scanning…" : usage?.snapshot ? "Refresh" : "Scan"}
        </button>
      </div>
      {!usage ? (
        <p className="text-muted-foreground">No snapshot yet</p>
      ) : usage.status !== "available" ? (
        <p>{usage.message ?? `Usage ${usage.status}`}</p>
      ) : (
        <>
          {usage.snapshot?.planType && <p>Plan: {usage.snapshot.planType}</p>}
          {(["primary", "secondary"] as const).map(
            (key) =>
              usage.snapshot?.[key] && (
                <p key={key}>
                  {key === "primary" ? "Session" : "Weekly"}: {usage.snapshot[key]!.usedPercent}%
                  used · resets {new Date(usage.snapshot[key]!.resetsAt).toLocaleString()}
                </p>
              ),
          )}
        </>
      )}
    </div>
  );
}

export type Runtime = { provider: RuntimeProvider; version: string; displayName: string };

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
      <Popover.Trigger className="rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="font-medium">{runtime.displayName}</span>{" "}
        <span className="text-muted-foreground">{runtime.version}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={8} className="z-50">
          <Popover.Popup className="w-80 rounded-lg border bg-popover p-4 text-sm text-popover-foreground shadow-lg outline-none">
            <RuntimeUsage usage={usage} onScan={onScan} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
