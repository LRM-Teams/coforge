import { expect, test } from "bun:test";
import {
  connectionLiveness,
  INBOUND_QUIET_MS,
  INBOUND_STALLED_MS,
} from "../src/connection/connection-liveness";

test("a connection that carried traffic recently is left alone", () => {
  expect(connectionLiveness(0)).toBe("carrying");
  expect(connectionLiveness(INBOUND_QUIET_MS - 1)).toBe("carrying");
});

test("a quiet connection is reported before it is torn down", () => {
  expect(connectionLiveness(INBOUND_QUIET_MS)).toBe("quiet");
  expect(connectionLiveness(INBOUND_STALLED_MS - 1)).toBe("quiet");
});

test("a connection that has carried nothing for the stalled window must be rebuilt", () => {
  expect(connectionLiveness(INBOUND_STALLED_MS)).toBe("stalled");
  expect(connectionLiveness(INBOUND_STALLED_MS * 10)).toBe("stalled");
});

test("the stalled window leaves room for more than one missed round trip", () => {
  expect(INBOUND_STALLED_MS).toBeGreaterThan(INBOUND_QUIET_MS);
  expect(INBOUND_STALLED_MS - INBOUND_QUIET_MS).toBeGreaterThanOrEqual(60_000);
});
