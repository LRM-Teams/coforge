import { describe, expect, test } from "bun:test";
import {
  AGENT_ENVIRONMENT_MAX_NAME_LENGTH,
  AGENT_ENVIRONMENT_MAX_SERIALIZED_LENGTH,
  AGENT_ENVIRONMENT_MAX_VALUE_LENGTH,
  AGENT_ENVIRONMENT_MAX_VARIABLES,
  AGENT_ENVIRONMENT_NAME_PATTERN,
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
});
