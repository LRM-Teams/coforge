import { describe, expect, test } from "bun:test";
import {
  CONTEXT_HANDOFF_THRESHOLD,
  ContextHandoffCoordinator,
  contextHandoffPrompt,
} from "#src/agent-runtime/context-handoff";

describe("ContextHandoffCoordinator", () => {
  test("requests a handoff once when usage reaches 80 percent", () => {
    const requests: string[] = [];
    const coordinator = new ContextHandoffCoordinator((prompt) => {
      requests.push(prompt);
    });

    expect(coordinator.observe(79_999, 100_000)).toBe(false);
    expect(coordinator.observe(80_000, 100_000)).toBe(true);
    expect(coordinator.observe(95_000, 100_000)).toBe(false);
    expect(requests).toEqual([contextHandoffPrompt(80)]);
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
