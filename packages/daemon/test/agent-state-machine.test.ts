import { describe, expect, test } from "bun:test";
import { AgentStateMachine } from "../src/agent-runtime/agent-state-machine";

describe("AgentStateMachine", () => {
  test("starts offline and becomes online only after runtime is ready", () => {
    const machine = new AgentStateMachine();

    expect(machine.state).toBe("offline");
    expect(machine.transition("runtime_ready")).toEqual({
      changed: true,
      from: "offline",
      to: "online",
    });
    expect(machine.state).toBe("online");
  });

  test("returns to offline when the runtime stops", () => {
    const machine = new AgentStateMachine();
    machine.transition("runtime_ready");

    expect(machine.transition("runtime_stopped")).toEqual({
      changed: true,
      from: "online",
      to: "offline",
    });
  });

  test("keeps repeated stop and startup-complete transitions idempotent", () => {
    const machine = new AgentStateMachine();

    expect(machine.transition("runtime_stopped")).toEqual({ changed: false });
    machine.transition("runtime_ready");
    expect(machine.transition("runtime_ready")).toEqual({ changed: false });
  });
});
