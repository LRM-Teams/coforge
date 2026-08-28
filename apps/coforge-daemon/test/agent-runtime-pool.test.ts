import { describe, expect, test } from "bun:test";
import { AgentRuntimePool } from "../src/agent-capacity/agent-runtime-pool";

describe("AgentRuntimePool", () => {
  test("enforces capacity", () => {
    const pool = new AgentRuntimePool(1);

    expect(pool.acquire("workspace-1", "computer-1", "agent-1")).toEqual({
      id: expect.any(String),
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-1",
    });
    expect(pool.acquire("workspace-2", "computer-2", "agent-2")).toBeUndefined();
    expect(pool.size).toBe(1);
  });

  test("shares capacity across connections", () => {
    const pool = new AgentRuntimePool(2);

    expect(pool.acquire("workspace-1", "computer-1", "agent-1")).toBeDefined();
    expect(pool.acquire("workspace-2", "computer-2", "agent-2")).toBeDefined();
    expect(pool.acquire("workspace-1", "computer-1", "agent-3")).toBeUndefined();
  });

  test("can reuse capacity after release", () => {
    const pool = new AgentRuntimePool(1);
    const handle = pool.acquire("workspace-1", "computer-1", "agent-1");

    expect(handle).toBeDefined();
    expect(pool.release(handle!.id)).toBe(true);
    expect(pool.size).toBe(0);
    expect(pool.acquire("workspace-2", "computer-2", "agent-2")).toBeDefined();
  });

  test("makes release idempotent and safe for unknown handles", () => {
    const pool = new AgentRuntimePool(1);
    const handle = pool.acquire("workspace-1", "computer-1", "agent-1")!;

    expect(pool.release(handle.id)).toBe(true);
    expect(pool.release(handle.id)).toBe(false);
    expect(pool.release("unknown-id")).toBe(false);
    expect(pool.size).toBe(0);
  });

  test("returns unique, non-guessable runtime identities", () => {
    const pool = new AgentRuntimePool(2);
    const first = pool.acquire("workspace-1", "computer-1", "agent-1")!;
    const second = pool.acquire("workspace-1", "computer-1", "agent-1")!;

    expect(first.id).not.toBe(second.id);
    expect(pool.release("connection-1:agent-1")).toBe(false);
    expect(pool.size).toBe(2);
  });
});
