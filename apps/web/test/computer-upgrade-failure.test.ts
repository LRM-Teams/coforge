import { expect, test } from "bun:test";
import {
  ComputerUpgradeFailureView,
  describeComputerUpgradeFailure,
  describeComputerUpgradeSuccess,
  describeUpgradeRequestError,
} from "../src/features/computers/upgrade-failure";
import {
  RESTART_MAX_POLLS,
  RESTART_POLL_INTERVAL_MS,
  UPGRADE_MAX_POLLS,
  UPGRADE_POLL_INTERVAL_MS,
} from "../src/features/computers/computer-detail";
import { AppError } from "../src/lib/app-error";
import { m } from "@/paraglide/messages";
import { COMPUTER_CLI_COMMANDS, UPGRADE_ERROR_CODE_VALUES } from "@lrm/coforge-sdk/internal";

/** Every step's `command`, across every reason and every known error code, must be one of the
 * CLI's real registered commands (never a made-up one) - `packages/computer/test/cli.test.ts`
 * asserts the CLI's actual commands equal this same shared list, so the two cannot silently
 * drift apart. `--supervisor` is the one flag this copy ever names on top of a bare command. */
function assertKnownCommand(command: string): void {
  expect(command.startsWith("coforge-computer ")).toBe(true);
  const rest = command.slice("coforge-computer ".length);
  const [cliCommand, ...flags] = rest.split(" ");
  expect((COMPUTER_CLI_COMMANDS as readonly string[]).includes(cliCommand ?? "")).toBe(true);
  for (const flag of flags) expect(flag).toBe("--supervisor");
}

test("a reported failure shows the Computer's own reason on one line, with steps to act on it", () => {
  const view = describeComputerUpgradeFailure({
    reason: "reported",
    error: "candidate failed at <path>",
  });

  expect(view.headline).toContain("candidate failed at <path>");
  expect(view.headline.split("\n")).toHaveLength(1);
  expect(view.steps.length).toBeGreaterThan(0);
  for (const step of view.steps) if (step.command) assertKnownCommand(step.command);
});

test("each inferred failure (no known error code) reads as its own sentence, never a bare code", () => {
  const views = (["timeout", "publication", "evidence", "reported"] as const).map((reason) =>
    describeComputerUpgradeFailure({ reason }),
  );

  expect(new Set(views.map((view) => view.headline)).size).toBe(4);
  for (const view of views) {
    expect(view.headline.endsWith(".")).toBe(true);
    expect(view.headline).not.toContain("_");
    expect(view.steps.length).toBeGreaterThan(0);
  }
});

test("the upgrade-failure table is exhaustive over every known error code, each with actionable steps", () => {
  const views = UPGRADE_ERROR_CODE_VALUES.map((errorCode) =>
    describeComputerUpgradeFailure({ reason: "reported", errorCode }),
  );

  // Every code produces its own headline (the table's Record<UpgradeErrorCode, ...> already
  // fails tsc if a code were missing; this proves each one is genuinely distinct copy, not the
  // same fallback repeated).
  expect(new Set(views.map((view) => view.headline)).size).toBe(UPGRADE_ERROR_CODE_VALUES.length);
  for (const view of views) {
    expect(view.headline).not.toContain("_");
    expect(view.headline.length).toBeGreaterThan(0);
    for (const step of view.steps) {
      expect(step.text.length).toBeGreaterThan(0);
      if (step.command) assertKnownCommand(step.command);
    }
  }
});

test("a pending operation's copy names its exact recovery commands in order", () => {
  const view = describeComputerUpgradeFailure({
    reason: "reported",
    errorCode: "UPGRADE_OPERATION_PENDING",
  });

  expect(view.headline).toBe(m.computer_upgrade_code_operation_pending());
  expect(view.steps.map((step) => step.command)).toEqual([
    "coforge-computer status",
    undefined,
    "coforge-computer restart --supervisor",
  ]);
});

test("an unknown or not-yet-understood error code falls back to the generic reported copy plus the Computer's own text", () => {
  const view = describeComputerUpgradeFailure({
    reason: "reported",
    error: "a brand-new failure this build has never seen",
    errorCode: "UPGRADE_SOMETHING_FUTURE",
  });

  expect(view.headline).toBe(
    `${m.computer_upgrade_failed_reported()}: a brand-new failure this build has never seen`,
  );
  expect(view.steps.length).toBeGreaterThan(0);
});

test("the upgrade panel waits longer than the restart panel — a real upgrade takes minutes", () => {
  // On s144 a healthy upgrade took about two minutes end to end (`upgrade-results/<id>.request.json`
  // to `.result.json`), longer than the window the restart panel uses. Reusing that window made a
  // running upgrade report a timeout, and the follow-up click report `UPGRADE_OPERATION_PENDING` as
  // a failure — the report a person actually saw.
  const upgradeWindowMs = UPGRADE_POLL_INTERVAL_MS * UPGRADE_MAX_POLLS;
  expect(upgradeWindowMs).toBeGreaterThanOrEqual(3 * 60_000);
  expect(upgradeWindowMs).toBeGreaterThan(RESTART_POLL_INTERVAL_MS * RESTART_MAX_POLLS);
});

test("rendering data for a pending-code failure: the exact headline and ordered steps computer-detail.tsx would show inline", () => {
  // computer-detail.tsx has no jsdom/testing-library harness in this repo yet; this asserts the
  // same data path the component renders from (`describeUpgradeRequestError` feeding the
  // `upgrade.state === "failed"` branch's headline/steps list) instead of a DOM render.
  const thrown = new ComputerUpgradeFailureView(
    describeComputerUpgradeFailure({ reason: "reported", errorCode: "UPGRADE_OPERATION_PENDING" }),
  );
  const copy = describeUpgradeRequestError(thrown);

  expect(copy.headline).toBe(m.computer_upgrade_code_operation_pending());
  expect(copy.steps).toEqual([
    { text: m.computer_upgrade_step_check_status(), command: "coforge-computer status" },
    { text: m.computer_upgrade_step_wait_running() },
    {
      text: m.computer_upgrade_step_restart_supervisor_retry(),
      command: "coforge-computer restart --supervisor",
    },
  ]);
  expect(copy.errorId).toBeUndefined();
});

test("an offline Computer reads as a human sentence, never the raw AppError wire encoding, with a fix", () => {
  const copy = describeUpgradeRequestError(new AppError("COMPUTER_OFFLINE", { errorId: "abc" }));

  expect(copy.headline).not.toContain("COFORGE_APP_ERROR");
  expect(copy.headline).not.toContain("COMPUTER_OFFLINE");
  expect(copy.headline.length).toBeGreaterThan(0);
  expect(copy.errorId).toBe("abc");
  expect(copy.steps.map((step) => step.command)).toEqual([
    "coforge-computer status",
    "coforge-computer start",
  ]);
});

test("a Computer with no reported identity reads as its own actionable sentence, with the exact restart command", () => {
  const copy = describeUpgradeRequestError(
    new AppError("COMPUTER_IDENTITY_UNKNOWN", { errorId: "def" }),
  );

  expect(copy.headline).toBe(m.computer_upgrade_identity_unknown());
  expect(copy.headline).not.toContain("COFORGE_APP_ERROR");
  expect(copy.headline).not.toContain("COMPUTER_IDENTITY_UNKNOWN");
  expect(copy.headline).not.toBe(
    describeUpgradeRequestError(new AppError("COMPUTER_OFFLINE")).headline,
  );
  expect(copy.errorId).toBe("def");
  expect(copy.steps).toEqual([
    {
      text: m.computer_upgrade_step_restart_supervisor(),
      command: "coforge-computer restart --supervisor",
    },
  ]);
});

test("an unavailable release feed reads as its own sentence", () => {
  const copy = describeUpgradeRequestError(new AppError("RELEASE_FEED_UNAVAILABLE"));

  expect(copy.headline).not.toContain("COFORGE_APP_ERROR");
  expect(copy.headline).not.toContain("RELEASE_FEED_UNAVAILABLE");
  expect(copy.errorId).toBeUndefined();
});

test("an unrelated AppError falls back to a generic sentence but keeps its reference id discoverable", () => {
  const copy = describeUpgradeRequestError(new AppError("INTERNAL_ERROR", { errorId: "xyz" }));

  expect(copy.headline).not.toContain("COFORGE_APP_ERROR");
  expect(copy.headline).not.toContain("INTERNAL_ERROR");
  expect(copy.errorId).toBe("xyz");
});

test("a serialized AppError decodes from its wire-encoded message the same way", () => {
  // This is exactly the shape TanStack's shallow Error serialization hands back to the client -
  // a plain Error whose message is the encoded AppError, not an AppError instance.
  const wire = new Error(new AppError("COMPUTER_OFFLINE", { errorId: "wire-id" }).message);

  const copy = describeUpgradeRequestError(wire);

  expect(copy.headline).not.toContain("COFORGE_APP_ERROR");
  expect(copy.errorId).toBe("wire-id");
});

test("a terminal poll failure's structured view passes through describeUpgradeRequestError unchanged", () => {
  const view = describeComputerUpgradeFailure({ reason: "timeout" });
  const copy = describeUpgradeRequestError(new ComputerUpgradeFailureView(view));

  expect(copy.headline).toBe(view.headline);
  expect(copy.steps).toEqual(view.steps);
  expect(copy.errorId).toBeUndefined();
});

test("a completed upgrade reads as one toast line naming the new version, never a bare code", () => {
  const line = describeComputerUpgradeSuccess("1.2.3");

  expect(line).toContain("1.2.3");
  expect(line.split("\n")).toHaveLength(1);
  expect(line).not.toContain("_");
});

test("the success line is never the same string as any failure headline, so one event is never shown twice", () => {
  const success = describeComputerUpgradeSuccess("1.2.3");
  const failureHeadlines = (["timeout", "publication", "evidence", "reported"] as const).map(
    (reason) => describeComputerUpgradeFailure({ reason }).headline,
  );

  expect(failureHeadlines).not.toContain(success);
});
