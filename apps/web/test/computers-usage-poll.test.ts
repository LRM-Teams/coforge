import { expect, test } from "bun:test";

import { waitForUsageScanResult } from "@/features/computers/usage-poll";

test("usage polling waits for the matching scan to leave pending", async () => {
  const responses = [
    { scanId: "old-scan", status: "available" as const },
    { scanId: "new-scan", status: "pending" as const },
    { scanId: "new-scan", status: "available" as const },
  ];
  let reads = 0;

  const result = await waitForUsageScanResult(
    "new-scan",
    async () => responses[Math.min(reads++, responses.length - 1)],
    async () => undefined,
  );

  expect(result).toEqual({ scanId: "new-scan", status: "available" });
  expect(reads).toBe(3);
});
