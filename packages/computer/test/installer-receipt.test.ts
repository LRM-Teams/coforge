import { describe, expect, test } from "bun:test";

import { ALLOWED_RECEIPTS, REJECTED_RECEIPTS, receiptOf } from "../scripts/installer-receipt-cases";
import { InstallerReceiptSchema } from "#src/release/installer-contract";

/** What a reader sees: the receipt after it went through a file. */
function throughFile(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("the installer receipt's status, error code, exit code, and dead-process evidence", () => {
  for (const { slug, fields } of ALLOWED_RECEIPTS) {
    test(`${slug} round-trips`, () => {
      const written = receiptOf(fields);
      expect<unknown>(InstallerReceiptSchema.parse(throughFile(written))).toEqual(written);
    });
  }

  for (const { name, fields } of REJECTED_RECEIPTS) {
    test(`${name} is rejected`, () => {
      expect(InstallerReceiptSchema.safeParse(throughFile(receiptOf(fields))).success).toBe(false);
    });
  }

  test("a receipt from a later installer with fields this build does not know is accepted", () => {
    const written = receiptOf({ status: "succeeded", exit_code: 0, x_from_a_later_version: [1] });
    expect<unknown>(InstallerReceiptSchema.parse(throughFile(written))).toEqual(written);
  });
});
