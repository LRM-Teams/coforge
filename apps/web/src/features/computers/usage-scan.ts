import type { RuntimeProvider } from "@coforge/protocol";

import { readUsage, scanUsage } from "./computers.functions";
import type { UsageView } from "./runtime-usage";
import { waitForUsageScanResult } from "./usage-poll";

/** Asks a Computer for a fresh usage snapshot and waits for that scan's result. */
export async function scanRuntimeUsage(
  computerId: string,
  provider: RuntimeProvider,
): Promise<UsageView> {
  const started = await scanUsage({ data: { computerId, provider } });
  const result = await waitForUsageScanResult(started.scanId, () =>
    readUsage({ data: { computerId, provider } }),
  );
  return { status: usageStatus(result.status), message: result.message, snapshot: result.snapshot };
}

function usageStatus(value: string): UsageView["status"] {
  if (
    value === "available" ||
    value === "unavailable" ||
    value === "reauth" ||
    value === "unsupported"
  )
    return value;
  return "error";
}
