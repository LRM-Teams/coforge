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

  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Temporal")!;
  Reflect.deleteProperty(globalThis, "Temporal");
  try {
    expect("Temporal" in globalThis).toBe(false);
    await ensureTemporal();
    expect(globalThis.Temporal).not.toBe(native);
    expect(
      globalThis.Temporal.Instant.fromEpochMilliseconds(0)
        .toZonedDateTimeISO("Asia/Shanghai")
        .toPlainDate()
        .toString(),
    ).toBe("1970-01-01");
  } finally {
    Object.defineProperty(globalThis, "Temporal", descriptor);
  }
});
