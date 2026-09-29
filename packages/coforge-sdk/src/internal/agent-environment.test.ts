import { describe, expect, test } from "bun:test";
import {
  AGENT_ENVIRONMENT_MAX_NAME_LENGTH,
  AGENT_ENVIRONMENT_MAX_SERIALIZED_LENGTH,
  AGENT_ENVIRONMENT_MAX_VALUE_LENGTH,
  AGENT_ENVIRONMENT_MAX_VARIABLES,
  AGENT_ENVIRONMENT_NAME_PATTERN,
  agentEnvironmentNameViolation,
  agentEnvironmentViolation,
  isReservedAgentEnvironmentName,
} from "./agent-environment";

describe("agent environment limits", () => {
  test("pins the values both edges enforce", () => {
    expect(AGENT_ENVIRONMENT_MAX_VARIABLES).toBe(64);
    expect(AGENT_ENVIRONMENT_MAX_NAME_LENGTH).toBe(128);
    expect(AGENT_ENVIRONMENT_MAX_VALUE_LENGTH).toBe(32_768);
    expect(AGENT_ENVIRONMENT_MAX_SERIALIZED_LENGTH).toBe(131_072);
  });

  test("accepts shell-identifier names and refuses anything else", () => {
    for (const name of ["A", "_", "A_1", "aBc9_", "_x"]) {
      expect(AGENT_ENVIRONMENT_NAME_PATTERN.test(name)).toBe(true);
    }
    for (const name of ["", "1A", "A-B", "A.B", "A B", "A=B", "Ä"]) {
      expect(AGENT_ENVIRONMENT_NAME_PATTERN.test(name)).toBe(false);
    }
  });

  test("reserves PATH and the COFORGE_ namespace, case-insensitively", () => {
    expect(isReservedAgentEnvironmentName("PATH")).toBe(true);
    expect(isReservedAgentEnvironmentName("path")).toBe(true);
    expect(isReservedAgentEnvironmentName("COFORGE_TOKEN")).toBe(true);
    expect(isReservedAgentEnvironmentName("coforge_token")).toBe(true);
    expect(isReservedAgentEnvironmentName("PATHX")).toBe(false);
    expect(isReservedAgentEnvironmentName("XCOFORGE_Y")).toBe(false);
    expect(isReservedAgentEnvironmentName("HOME")).toBe(false);
  });

  test("names the first rule a variable name breaks", () => {
    expect(agentEnvironmentNameViolation("MY_VAR")).toBeUndefined();
    expect(agentEnvironmentNameViolation("11")).toBe("invalid-name");
    expect(agentEnvironmentNameViolation("A".repeat(129))).toBe("invalid-name");
    expect(agentEnvironmentNameViolation("path")).toBe("reserved-name");
    expect(agentEnvironmentNameViolation("COFORGE_TOKEN")).toBe("reserved-name");
  });

  test("names the rule a whole environment breaks, or nothing when it is valid", () => {
    expect(agentEnvironmentViolation({ A: "1", _B: "" })).toBeUndefined();
    expect(
      agentEnvironmentViolation(
        Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`A${i}`, "s"])),
      ),
    ).toBe("too-many");
    expect(agentEnvironmentViolation({ "11": "11" })).toBe("invalid-name");
    expect(agentEnvironmentViolation({ PATH: "/bin" })).toBe("reserved-name");
    expect(agentEnvironmentViolation({ A: 1 })).toBe("invalid-value");
    expect(agentEnvironmentViolation({ A: "a\0" })).toBe("invalid-value");
    expect(agentEnvironmentViolation({ A: "s".repeat(32_769) })).toBe("invalid-value");
    const big = "s".repeat(32_768);
    expect(agentEnvironmentViolation({ A: big, B: big, C: big, D: big })).toBe("too-large");
  });
});
