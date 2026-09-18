import { expect, test } from "bun:test";

import { waitForUsageScanResult } from "@/features/computers/usage-poll";

test("usage polling waits until the new scan's own result replaces the previous one", async () => {
  const reads = [
    { state: "fresh" as const, result: { scanId: "old-scan" }, pendingScanId: "new-scan" },
    { state: "fresh" as const, result: { scanId: "old-scan" }, pendingScanId: "new-scan" },
    { state: "fresh" as const, result: { scanId: "new-scan" } },
  ];
  let count = 0;

  const result = await waitForUsageScanResult(
    "new-scan",
    async () => reads[Math.min(count++, reads.length - 1)]!,
    async () => undefined,
  );

  expect(result).toEqual({ state: "fresh", result: { scanId: "new-scan" } });
  expect(count).toBe(3);
});

test("the previous result stays readable the whole time a new scan is pending", async () => {
  const reads = [
    { state: "stale" as const, result: { scanId: "old-scan" }, pendingScanId: "new-scan" },
    { state: "fresh" as const, result: { scanId: "new-scan" } },
  ];
  let count = 0;
  const seen: unknown[] = [];

  await waitForUsageScanResult(
    "new-scan",
    async () => {
      const current = reads[Math.min(count++, reads.length - 1)]!;
      seen.push(current.result?.scanId);
      return current;
    },
    async () => undefined,
  );

  // The stale previous result was observable (never became `undefined`/missing) before the new
  // scan's own result arrived.
  expect(seen).toEqual(["old-scan", "new-scan"]);
});

test("gives up after the 15s timeout when the scan never produces its own result", async () => {
  let count = 0;
  await expect(
    waitForUsageScanResult(
      "new-scan",
      async (): Promise<{ result?: { scanId: string }; pendingScanId?: string }> => {
        count += 1;
        return { pendingScanId: "new-scan" };
      },
      async () => undefined,
    ),
  ).rejects.toThrow("usage scan timed out");
  // One initial read plus 150 retries at the 100ms poll interval covers 15s.
  expect(count).toBe(151);
});
