import { expect, test } from "bun:test";

import { ensureTemporal } from "#src/lib/temporal-support";

/**
 * Browsers without a native Temporal (Safari today) get the polyfill before the app hydrates;
 * everywhere else, including Bun, the native implementation stays untouched.
 */
test("keeps a native Temporal and installs one where the runtime has none", async () => {
  const native = globalThis.Temporal;
  expect(native).toBeDefined();

  await ensureTemporal();
  expect(globalThis.Temporal).toBe(native);

  // Installing the polyfill also replaces `Intl.DateTimeFormat` and adds
  // `Date.prototype.toTemporalInstant`; all three are restored afterwards.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Temporal")!;
  const dateTimeFormat = Object.getOwnPropertyDescriptor(Intl, "DateTimeFormat")!;
  const toTemporalInstant = Object.getOwnPropertyDescriptor(Date.prototype, "toTemporalInstant");
  Reflect.deleteProperty(globalThis, "Temporal");
  try {
    expect("Temporal" in globalThis).toBe(false);
    await ensureTemporal();
    expect(globalThis.Temporal).not.toBe(native);
    // The replaced formatter still formats a plain Date the same way.
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date(Date.UTC(2026, 8, 24))),
    ).toBe("2026-09-24");
    expect(
      globalThis.Temporal.Instant.fromEpochMilliseconds(0)
        .toZonedDateTimeISO("Asia/Shanghai")
        .toPlainDate()
        .toString(),
    ).toBe("1970-01-01");
  } finally {
    Object.defineProperty(globalThis, "Temporal", descriptor);
    Object.defineProperty(Intl, "DateTimeFormat", dateTimeFormat);
    if (toTemporalInstant)
      Object.defineProperty(Date.prototype, "toTemporalInstant", toTemporalInstant);
    else Reflect.deleteProperty(Date.prototype, "toTemporalInstant");
  }
});
