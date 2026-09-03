import { describe, expect, test } from "bun:test";
import { AgentStateMachine } from "../src/agent-runtime/agent-state-machine";

describe("AgentStateMachine", () => {
  test("starts inactive and becomes active only after runtime is ready", () => {
    const machine = new AgentStateMachine();

    expect(machine.state).toBe("inactive");
    expect(machine.transition("runtime_ready")).toEqual({
      changed: true,
      from: "inactive",
      to: "active",
    });
    expect(machine.state).toBe("active");
  });

  test("stays active when its runtime is released but can be deactivated", () => {
    const machine = new AgentStateMachine();
    machine.transition("runtime_ready");

    expect(machine.transition("runtime_released")).toEqual({ changed: false });
    expect(machine.state).toBe("active");
    expect(machine.transition("deactivate")).toEqual({
      changed: true,
      from: "active",
      to: "inactive",
    });
  });

  test("keeps repeated stop and startup-complete transitions idempotent", () => {
    const machine = new AgentStateMachine();

    expect(machine.transition("deactivate")).toEqual({ changed: false });
    machine.transition("runtime_ready");
    expect(machine.transition("runtime_ready")).toEqual({ changed: false });
  });
});
