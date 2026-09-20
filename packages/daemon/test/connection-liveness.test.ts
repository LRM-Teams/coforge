import { expect, test } from "bun:test";
import {
  connectionLiveness,
  INBOUND_QUIET_MS,
  INBOUND_STALLED_MS,
} from "../src/connection/connection-liveness";
import { COMPUTER_STATUS_REFRESH_MS } from "../src/connection/daemon-connection";

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

test("both windows are measured in the status round trips that feed them", () => {
  // The only inbound traffic a Workspace with nothing to say produces is the answered status
  // RPC, so these windows mean nothing except as a count of those refreshes. A window shorter
  // than a couple of them would rebuild a healthy connection over one lost reply.
  expect(INBOUND_QUIET_MS).toBeGreaterThanOrEqual(COMPUTER_STATUS_REFRESH_MS * 2);
  expect(INBOUND_STALLED_MS).toBeGreaterThanOrEqual(COMPUTER_STATUS_REFRESH_MS * 4);
  expect(INBOUND_STALLED_MS).toBeGreaterThan(INBOUND_QUIET_MS);
});
