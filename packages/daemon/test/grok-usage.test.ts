import { expect, test } from "bun:test";
import { JsonlRequestError } from "#src/code-agent/jsonl-process";
import { UsageUnavailableError, UsageUnsupportedError } from "#src/code-agent/contract";
import { classifyUsageFailure, projectBilling } from "#src/code-agent/grok/usage";

/** A billing record shaped like Grok's `_x.ai/billing` answer, overridable per test. */
function billingFixture(overrides: Record<string, unknown> = {}) {
  return {
    subscription_tier: "pro",
    config: {
      creditUsagePercent: 42.5,
      used: 8.5,
      monthlyLimit: 20,
      currentPeriod: { type: "Monthly", end: 1_793_304_000 },
      onDemandCap: undefined,
      onDemandUsed: undefined,
      ...overrides,
    },
  };
}

test("projectBilling prefers the explicit creditUsagePercent and reports the period", () => {
  const snapshot = projectBilling(billingFixture(), "ada@example.com");
  expect(snapshot.provider).toBe("grok");
  expect(snapshot.planType).toBe("pro");
  expect(snapshot.accountLabel).toBe("ada@example.com");
  expect(snapshot.health).toBe("ok");
  expect(snapshot.primary).toMatchObject({
    id: "grok-monthly",
    usedPercent: 42.5,
    status: "ok",
    windowDurationMinutes: 43200,
    resetsAt: new Date(1_793_304_000 * 1000).toISOString(),
  });
  expect(snapshot.secondary).toBeUndefined();
});

test("projectBilling derives the percent from used/monthlyLimit when explicit is missing", () => {
  const snapshot = projectBilling(
    billingFixture({ creditUsagePercent: undefined, used: 15, monthlyLimit: 20 }),
  );
  expect(snapshot.primary!.usedPercent).toBe(75);
});

test("projectBilling adds a pay-as-you-go secondary window when an on-demand cap exists", () => {
  const snapshot = projectBilling(
    billingFixture({ creditUsagePercent: 10, onDemandCap: 10, onDemandUsed: 2.5 }),
  );
  expect(snapshot.secondary).toMatchObject({
    id: "grok-pay-as-you-go",
    usedPercent: 25,
    status: "ok",
    windowDurationMinutes: 43200,
  });
});

test("projectBilling reports rate_limited only when the primary and any secondary are exhausted", () => {
  const primaryOnly = projectBilling(billingFixture({ creditUsagePercent: 100 }));
  expect(primaryOnly.health).toBe("rate_limited");
  expect(primaryOnly.primary!.status).toBe("limit_reached");
  // A live secondary keeps the account healthy even with the subscription drained.
  const withCap = projectBilling(
    billingFixture({ creditUsagePercent: 100, onDemandCap: 10, onDemandUsed: 1 }),
  );
  expect(withCap.health).toBe("ok");
  const bothDrained = projectBilling(
    billingFixture({ creditUsagePercent: 100, onDemandCap: 10, onDemandUsed: 10 }),
  );
  expect(bothDrained.health).toBe("rate_limited");
  expect(bothDrained.secondary!).toMatchObject({ status: "limit_reached", usedPercent: 100 });
});

test("projectBilling clamps the reported percent at 100", () => {
  const snapshot = projectBilling(billingFixture({ creditUsagePercent: 150 }));
  expect(snapshot.primary!.usedPercent).toBe(100);
});

test("projectBilling falls back to billingPeriodEnd when the period object is absent", () => {
  const snapshot = projectBilling({
    config: {
      creditUsagePercent: 5,
      billingPeriodEnd: "2026-10-01T00:00:00.000Z",
    },
  });
  expect(snapshot.primary!.resetsAt).toBe("2026-10-01T00:00:00.000Z");
  // No usable period label: the window still gets a stable default id.
  expect(snapshot.primary!.id).toBe("grok-monthly");
});

test("projectBilling refuses a record without a config block", () => {
  expect(() => projectBilling({ unexpected: true })).toThrow(UsageUnsupportedError);
  expect(() => projectBilling(undefined)).toThrow(UsageUnsupportedError);
});

test("projectBilling refuses a record with no usable percentage", () => {
  expect(() => projectBilling({ config: { used: 5, monthlyLimit: 0 } })).toThrow(
    "Grok returned no usable account usage percentage",
  );
  expect(() => projectBilling({ config: { creditUsagePercent: -1 } })).toThrow(
    "Grok returned no usable account usage percentage",
  );
});

test("classifyUsageFailure maps the ACP refusals to their contract classes", () => {
  const jsonlError = (code: number | undefined, message: unknown) =>
    new JsonlRequestError({ code, message });
  // -32601 is "method not found": the CLI build has no billing method at all.
  expect(classifyUsageFailure(jsonlError(-32601, "method not found"))).toBeInstanceOf(
    UsageUnsupportedError,
  );
  // -32000 and any auth-flavored message mean "cannot authenticate right now".
  expect(classifyUsageFailure(jsonlError(-32000, "unauthorized"))).toBeInstanceOf(
    UsageUnavailableError,
  );
  expect(classifyUsageFailure(jsonlError(undefined, "Not logged in"))).toBeInstanceOf(
    UsageUnavailableError,
  );
  expect(classifyUsageFailure(jsonlError(undefined, "please re-authenticate"))).toBeInstanceOf(
    UsageUnavailableError,
  );
  // A non-JSONL failure and an unrecognized shape propagate unchanged.
  expect(classifyUsageFailure(new Error("process exited"))).toBeUndefined();
  expect(classifyUsageFailure(jsonlError(-32700, "parse error"))).toBeUndefined();
});
