import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKSPACE_HEALTH_DEGRADED_THRESHOLD,
  WorkspaceHealthJournal,
} from "../src/supervisor/workspace-health-journal";
import { guardWorkspaceRunnerStart } from "../src/supervisor/workspace-runner-guard";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "coforge-workspace-runner-guard-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function path() {
  return join(directory, "health.json");
}

test("a fresh Workspace proceeds and records itself live", async () => {
  const journal = new WorkspaceHealthJournal(path());

  const outcome = await guardWorkspaceRunnerStart(journal);

  expect(outcome).toEqual({ action: "proceed" });
  expect(await journal.wasLeftRunning()).toBe(true);
});

test("a graceful predecessor (recordGracefulStop) is not treated as a crash", async () => {
  const journal = new WorkspaceHealthJournal(path());
  await journal.recordStart();
  await journal.recordGracefulStop();

  const outcome = await guardWorkspaceRunnerStart(journal);

  expect(outcome).toEqual({ action: "proceed" });
  const state = await journal.state();
  expect(state).toEqual({ status: "ok" });
});

test("a predecessor that left the live marker set counts as one unexpected death", async () => {
  const journal = new WorkspaceHealthJournal(path());
  await journal.recordStart(); // predecessor started and never stopped cleanly

  const outcome = await guardWorkspaceRunnerStart(journal);

  expect(outcome).toEqual({ action: "proceed" });
  expect(await journal.wasLeftRunning()).toBe(true); // this run's own recordStart
});

test("the crash that reaches the threshold latches degraded and exits instead of proceeding", async () => {
  const journal = new WorkspaceHealthJournal(path());
  // Simulate WORKSPACE_HEALTH_DEGRADED_THRESHOLD - 1 prior unexpected deaths already recorded.
  for (let i = 0; i < WORKSPACE_HEALTH_DEGRADED_THRESHOLD - 1; i += 1) await journal.recordCrash();
  await journal.recordStart(); // the run that is about to be found dead below

  const outcome = await guardWorkspaceRunnerStart(journal);

  expect(outcome.action).toBe("exit");
  if (outcome.action !== "exit") throw new Error("unreachable");
  expect(outcome.crashCount).toBe(WORKSPACE_HEALTH_DEGRADED_THRESHOLD);
  const state = await journal.state();
  expect(state.status).toBe("degraded");
});

test("an already-degraded journal exits immediately without recording another crash", async () => {
  const journal = new WorkspaceHealthJournal(path());
  await journal.markTerminal("Workspace configuration is invalid");

  const outcome = await guardWorkspaceRunnerStart(journal);

  expect(outcome).toEqual({
    action: "exit",
    reason: "Workspace configuration is invalid",
    crashCount: 0,
    since: ((await journal.state()) as { since: string }).since,
  });
});
