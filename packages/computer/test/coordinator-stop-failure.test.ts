import { expect, test } from "bun:test";
import { coordinatorStopFailure } from "#src/release/upgrade-lifecycle";

test("a refused supervisor stop keeps the platform host's own reason", () => {
  const cause = new Error(
    "`systemctl --user stop coforge-daemon.service` failed (1): Failed to connect to bus: No medium found. This shell has no systemd user session.",
  );

  const failure = coordinatorStopFailure(cause, false);

  expect(failure.message).toContain("Failed to connect to bus: No medium found");
  expect(failure.message).toContain("no systemd user session");
  expect(failure.message).not.toContain("foreground externally supervised");
  expect(failure.cause).toBe(cause);
});

test("a Computer proven to have no user service still reads as foreground supervised", () => {
  const cause = new Error("launchctl print failed (113): Could not find service");

  const failure = coordinatorStopFailure(cause, true);

  expect(failure.message).toContain("foreground externally supervised");
  expect(failure.message).toContain("launchctl print failed (113)");
  expect(failure.message).toContain("coforge-computer start");
  expect(failure.cause).toBe(cause);
});
