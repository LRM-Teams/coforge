import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { HeldBusyAgent } from "@lrm/coforge-sdk/internal";
import {
  answeredWithin,
  holdRunnersUntilQuiescent,
  RUNNER_HOLD_MS,
  RUNNER_HOLD_POLL_MS,
  type RunnerHoldSnapshot,
} from "#src/supervisor/runner-hold";

/** A virtual clock: `sleep` advances `now` instantly, so a 30s bound costs no wall time. */
function clock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (milliseconds: number) => {
      current += milliseconds;
    },
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

function busy(agentId: string, detailKind = "tool_started"): HeldBusyAgent {
  return { workspaceId: "workspace-a", agentId, detailKind, busySinceMs: 0 };
}

const idle: RunnerHoldSnapshot = { busyAgents: [], unreachableWorkspaceIds: [] };

describe("runner hold quiescence wait", () => {
  test("returns as soon as every Agent is idle, without burning the whole budget", async () => {
    const time = clock();
    let calls = 0;
    const outcome = await holdRunnersUntilQuiescent({
      hold: async () => {
        calls += 1;
        return calls < 3 ? { busyAgents: [busy("agent-a")], unreachableWorkspaceIds: [] } : idle;
      },
      ...time,
    });

    expect(outcome.quiescent).toBe(true);
    expect(outcome.busyAgents).toEqual([]);
    expect(calls).toBe(3);
    expect(outcome.elapsedMs).toBe(2 * RUNNER_HOLD_POLL_MS);
    expect(outcome.elapsedMs).toBeLessThan(RUNNER_HOLD_MS);
  });

  test("proceeds at the 30s bound and reports every Agent still busy at the deadline", async () => {
    const time = clock();
    const logged: Array<Record<string, unknown>> = [];
    const outcome = await holdRunnersUntilQuiescent({
      hold: async () => ({
        busyAgents: [busy("agent-a", "running_command"), busy("agent-b", "model_request_started")],
        unreachableWorkspaceIds: [],
      }),
      onDeadline: (entry) => logged.push(entry),
      ...time,
    });

    expect(outcome.quiescent).toBe(false);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(RUNNER_HOLD_MS);
    expect(logged).toHaveLength(2);
    expect(logged.map((entry) => entry.event)).toEqual([
      "restart:runner_hold_deadline",
      "restart:runner_hold_deadline",
    ]);
    expect(logged.map((entry) => entry.agent_id)).toEqual(["agent-a", "agent-b"]);
    expect(logged.map((entry) => entry.detail_kind)).toEqual([
      "running_command",
      "model_request_started",
    ]);
    for (const entry of logged) expect(entry.elapsed_ms).toBeGreaterThanOrEqual(RUNNER_HOLD_MS);
  });

  test("an unreachable Workspace counts as idle and does not extend the hold", async () => {
    const time = clock();
    const outcome = await holdRunnersUntilQuiescent({
      hold: async () => ({ busyAgents: [], unreachableWorkspaceIds: ["workspace-b"] }),
      ...time,
    });

    expect(outcome.quiescent).toBe(true);
    expect(outcome.elapsedMs).toBe(0);
    expect(outcome.unreachableWorkspaceIds).toEqual(["workspace-b"]);
  });

  test("a Coordinator that cannot be asked at all never blocks the caller", async () => {
    const time = clock();
    const outcome = await holdRunnersUntilQuiescent({
      hold: async () => {
        throw new Error("supervisor socket is gone");
      },
      ...time,
    });

    expect(outcome.quiescent).toBe(true);
    expect(outcome.busyAgents).toEqual([]);
    expect(outcome.elapsedMs).toBe(0);
  });

  test("a hold that starts failing mid-poll stops the wait rather than spinning to the bound", async () => {
    const time = clock();
    let calls = 0;
    const outcome = await holdRunnersUntilQuiescent({
      hold: async () => {
        calls += 1;
        if (calls === 1) return { busyAgents: [busy("agent-a")], unreachableWorkspaceIds: [] };
        throw new Error("supervisor went away mid-hold");
      },
      ...time,
    });

    expect(outcome.quiescent).toBe(true);
    expect(calls).toBe(2);
    expect(outcome.elapsedMs).toBe(RUNNER_HOLD_POLL_MS);
  });
});

describe("answeredWithin", () => {
  test("rejects with the given message once the timeout passes", async () => {
    await expect(answeredWithin(new Promise(() => {}), 10, "no answer")).rejects.toThrow(
      "no answer",
    );
  });

  test("an answered race leaves nothing that keeps the process alive", async () => {
    // The 2026-09-17 incident: the losing `Bun.sleep(5_000)` of a settled race kept the
    // Coordinator alive 5 s past its own shutdown. Only a real process exit can prove the absence
    // of a pending timer, so this measures one.
    const source = `
      import { answeredWithin } from ${JSON.stringify(join(import.meta.dir, "../src/supervisor/runner-hold"))};
      console.log(await answeredWithin(Promise.resolve("answered"), 5_000, "timeout"));
    `;
    const started = performance.now();
    const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect({ code, stdout: stdout.trim() }).toEqual({ code: 0, stdout: "answered" });
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
