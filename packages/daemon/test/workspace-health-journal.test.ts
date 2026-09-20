import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKSPACE_HEALTH_CRASH_WINDOW_MS,
  WORKSPACE_HEALTH_DEGRADED_THRESHOLD,
  WorkspaceHealthJournal,
  workspaceHealthJournalPath,
} from "../src/supervisor/workspace-health-journal";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "coforge-workspace-health-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function journalAt(path: string, now: () => number = Date.now) {
  return new WorkspaceHealthJournal(path, now);
}

test("a fresh journal with no file yet reports ok", async () => {
  const journal = journalAt(join(directory, "health.json"));

  expect(await journal.state()).toEqual({ status: "ok" });
  expect(await journal.wasLeftRunning()).toBe(false);
});

test("recordStart marks the run live; a later recordGracefulStop clears it", async () => {
  const path = join(directory, "health.json");
  const journal = journalAt(path);
  await journal.recordStart();

  // A fresh instance reading the same file stands in for the next process invocation.
  expect(await journalAt(path).wasLeftRunning()).toBe(true);

  await journal.recordGracefulStop();
  expect(await journalAt(path).wasLeftRunning()).toBe(false);
});

test("fewer than the threshold of crashes inside the window stays ok", async () => {
  let now = 1_000_000;
  const journal = journalAt(join(directory, "health.json"), () => now);

  for (let i = 0; i < WORKSPACE_HEALTH_DEGRADED_THRESHOLD - 1; i += 1) {
    await journal.recordCrash(now);
    now += 1_000;
  }

  expect(await journal.state()).toEqual({
    status: "ok",
  });
});

test("reaching the crash threshold inside the window latches degraded with a crash-loop reason", async () => {
  let now = 1_000_000;
  const journal = journalAt(join(directory, "health.json"), () => now);

  for (let i = 0; i < WORKSPACE_HEALTH_DEGRADED_THRESHOLD; i += 1) {
    await journal.recordCrash(now);
    now += 1_000;
  }

  const state = await journal.state();
  expect(state.status).toBe("degraded");
  if (state.status !== "degraded") throw new Error("unreachable");
  expect(state.crashCount).toBe(WORKSPACE_HEALTH_DEGRADED_THRESHOLD);
  expect(state.since).toBe(new Date(now - 1_000).toISOString());
  expect(state.reason.length).toBeGreaterThan(0);
});

test("crashes older than the window are pruned and never reach the threshold", async () => {
  let now = 1_000_000;
  const journal = journalAt(join(directory, "health.json"), () => now);

  await journal.recordCrash(now);
  await journal.recordCrash(now);
  now += WORKSPACE_HEALTH_CRASH_WINDOW_MS + 1;
  await journal.recordCrash(now);

  expect(await journal.state()).toEqual({ status: "ok" });
});

test("once latched degraded by crash count, the latch survives the crash window aging out", async () => {
  let now = 1_000_000;
  const journal = journalAt(join(directory, "health.json"), () => now);
  for (let i = 0; i < WORKSPACE_HEALTH_DEGRADED_THRESHOLD; i += 1) {
    await journal.recordCrash(now);
    now += 1_000;
  }
  expect((await journal.state()).status).toBe("degraded");

  now += WORKSPACE_HEALTH_CRASH_WINDOW_MS * 10;
  expect((await journal.state()).status).toBe("degraded");
});

test("markTerminal latches degraded immediately with the given reason, independent of crash count", async () => {
  const path = join(directory, "health.json");
  const journal = journalAt(path);
  await journal.markTerminal("Workspace configuration is invalid");

  const state = await journal.state();
  expect(state.status).toBe("degraded");
  if (state.status !== "degraded") throw new Error("unreachable");
  expect(state.reason).toBe("Workspace configuration is invalid");
  expect(state.crashCount).toBe(0);
  expect(typeof state.since).toBe("string");
});

test("clear resets a degraded journal back to ok", async () => {
  const path = join(directory, "health.json");
  const journal = journalAt(path);
  await journal.markTerminal("stuck");
  expect((await journal.state()).status).toBe("degraded");

  await journal.clear();

  expect(await journal.state()).toEqual({ status: "ok" });
});

test("workspaceHealthJournalPath is stable for a given Workspace state directory", () => {
  const path = workspaceHealthJournalPath("/state/workspaces/abc");
  expect(path).toBe(join("/state/workspaces/abc", "health.json"));
});
