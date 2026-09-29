import { expect, test } from "bun:test";

import {
  DAEMON_CONNECT_REJECTION_CODES,
  DAEMON_RECONNECT_DISCONNECT,
  daemonConnectRejectionReason,
} from "./daemon-connect-rejection";

test("the server's reconnect request is a code the client reconnects on, and no refusal", () => {
  // centrifuge-js stops for good on 3500-3999 and 4500-4999 and reconnects on 4000-4499.
  expect(DAEMON_RECONNECT_DISCONNECT.code).toBeGreaterThanOrEqual(4000);
  expect(DAEMON_RECONNECT_DISCONNECT.code).toBeLessThan(4500);
  expect(daemonConnectRejectionReason(DAEMON_RECONNECT_DISCONNECT)).toBeUndefined();
  for (const code of Object.values(DAEMON_CONNECT_REJECTION_CODES)) {
    expect(code).toBeGreaterThanOrEqual(4500);
    expect(code).toBeLessThan(5000);
  }
});
