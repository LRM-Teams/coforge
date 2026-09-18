import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

import { readUsage, scanUsage } from "./computers.functions";
import { waitForUsageScanResult } from "./usage-poll";

/**
 * Asks a Computer for a fresh usage snapshot and waits for that scan's own result — the
 * previously cached result (if any) stays readable through `readUsage` the whole time, so this
 * never blanks a caller's display while the scan is in flight.
 */
export function scanRuntimeUsage(computerId: string, provider: RuntimeProvider) {
  return (async () => {
    const { scanId } = await scanUsage({ data: { computerId, provider } });
    return waitForUsageScanResult(scanId, () => readUsage({ data: { computerId, provider } }));
  })();
}
