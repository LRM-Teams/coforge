import { describe, expect, test } from "bun:test";
import { computedAgentCapacityPolicy, resolveAgentCapacity } from "../src/agent-capacity/policy";

const resources = { cpuCores: 8, memoryBytes: 16 * 1024 ** 3 };

describe("Agent capacity policy", () => {
  test("prefers explicit configured capacity", () => {
    expect(
      resolveAgentCapacity({
        configuredCapacity: 3,
        environment: { COFORGE_AGENT_CAPACITY: "7" },
        resources,
      }),
    ).toBe(3);
  });

  test("uses environment before computed policy", () => {
    expect(resolveAgentCapacity({ environment: { COFORGE_AGENT_CAPACITY: "4" }, resources })).toBe(
      4,
    );
  });

  test("uses computed policy as fallback", () => {
    expect(resolveAgentCapacity({ resources })).toBe(8);
  });

  test("rejects invalid explicit and environment configuration", () => {
    expect(() => resolveAgentCapacity({ configuredCapacity: 0, resources })).toThrow(
      "configured Agent capacity",
    );
    expect(() =>
      resolveAgentCapacity({ environment: { COFORGE_AGENT_CAPACITY: "2.5" }, resources }),
    ).toThrow("COFORGE_AGENT_CAPACITY");
  });

  test("applies conservative 2 GiB formula and minimum", () => {
    expect(computedAgentCapacityPolicy.resolve({ cpuCores: 8, memoryBytes: 4 * 1024 ** 3 })).toBe(
      2,
    );
    expect(computedAgentCapacityPolicy.resolve({ cpuCores: 8, memoryBytes: 1 })).toBe(1);
    expect(computedAgentCapacityPolicy.resolve({ cpuCores: 2, memoryBytes: 16 * 1024 ** 3 })).toBe(
      2,
    );
  });

  test("rejects invalid resource snapshots", () => {
    expect(() => computedAgentCapacityPolicy.resolve({ cpuCores: 0, memoryBytes: 1 })).toThrow(
      "cpuCores",
    );
    expect(() => computedAgentCapacityPolicy.resolve({ cpuCores: 1, memoryBytes: 0 })).toThrow(
      "memoryBytes",
    );
  });
});
