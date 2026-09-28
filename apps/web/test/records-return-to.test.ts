import { expect, test } from "bun:test";

import { sanitizeRecordsReturnTo } from "#src/features/records/records-return-to";

test("sanitizeRecordsReturnTo keeps a Records path inside a Workspace", () => {
  expect(sanitizeRecordsReturnTo("/w/acme/records/overview-1")).toBe("/w/acme/records/overview-1");
  expect(sanitizeRecordsReturnTo("/w/acme-labs/records/overview-1?tab=weekly")).toBe(
    "/w/acme-labs/records/overview-1?tab=weekly",
  );
});

test("sanitizeRecordsReturnTo refuses open redirects and paths outside Records", () => {
  expect(sanitizeRecordsReturnTo("/records/overview-1")).toBeUndefined();
  expect(sanitizeRecordsReturnTo("/w/acme/members")).toBeUndefined();
  expect(sanitizeRecordsReturnTo("/w/acme/records")).toBeUndefined();
  expect(sanitizeRecordsReturnTo("//evil.example/w/acme/records/x")).toBeUndefined();
  expect(sanitizeRecordsReturnTo("https://evil.example/w/acme/records/x")).toBeUndefined();
  expect(sanitizeRecordsReturnTo("/w/Acme/records/x")).toBeUndefined();
  expect(sanitizeRecordsReturnTo("/w/../records/x")).toBeUndefined();
  expect(sanitizeRecordsReturnTo("/w/acme/records/../../settings")).toBeUndefined();
  expect(sanitizeRecordsReturnTo("/w/acme/records/x?next=https://evil.example")).toBeUndefined();
  expect(sanitizeRecordsReturnTo("/w/acme/records/x\\y")).toBeUndefined();
  expect(sanitizeRecordsReturnTo(`/w/acme/records/${"x".repeat(200)}`)).toBeUndefined();
  expect(sanitizeRecordsReturnTo(undefined)).toBeUndefined();
});
