import { describe, expect, test } from "bun:test";
import {
  CONTEXT_HANDOFF_THRESHOLD,
  ContextHandoffCoordinator,
  contextHandoffActivity,
  contextHandoffPrompt,
} from "#src/agent-runtime/context-handoff";

describe("ContextHandoffCoordinator", () => {
  test("requests a handoff once when usage reaches the threshold", () => {
    const requests: Array<{ prompt: string; percent: number }> = [];
    const coordinator = new ContextHandoffCoordinator((handoff) => {
      requests.push(handoff);
    });

    expect(coordinator.observe(79_999, 100_000)).toBe(false);
    expect(coordinator.observe(80_000, 100_000)).toBe(true);
    expect(coordinator.observe(95_000, 100_000)).toBe(false);
    expect(requests).toEqual([{ prompt: contextHandoffPrompt(80), percent: 80 }]);
  });

  test("the prompt and the activity state the same percent, which is the one observed", () => {
    // A window that is past the threshold but not exactly at it: the two messages describe one
    // event, so neither may round to the threshold instead of reporting what was measured.
    const requests: Array<{ prompt: string; percent: number }> = [];
    const coordinator = new ContextHandoffCoordinator((handoff) => {
      requests.push(handoff);
    });

    expect(coordinator.observe(83_400, 100_000)).toBe(true);
    expect(requests).toHaveLength(1);
    const [handoff] = requests;
    expect(handoff!.percent).toBe(83);
    expect(contextHandoffActivity(handoff!.percent)).toBe(
      "Context usage reached 83%; preparing handoff.",
    );
    expect(handoff!.prompt).toContain("Context usage reached 83% of the provider window.");
    // The threshold itself stays the one spelling of "80%": the activity only ever echoes a
    // percent it was handed.
    expect(Math.floor(CONTEXT_HANDOFF_THRESHOLD * 100)).toBe(80);
  });

  test("ignores invalid readings and can be reset for a new session", () => {
    const coordinator = new ContextHandoffCoordinator(() => {});
    expect(coordinator.observe(1, 0)).toBe(false);
    expect(coordinator.observe(-1, 100)).toBe(false);
    expect(coordinator.observe(100_000, 100_000)).toBe(true);
    coordinator.reset();
    expect(coordinator.observe(CONTEXT_HANDOFF_THRESHOLD * 100, 100)).toBe(true);
  });
});
