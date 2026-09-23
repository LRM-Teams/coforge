import { describe, expect, test } from "bun:test";

import {
  AGENT_VISIBILITY,
  AGENT_VISIBILITY_VALUES,
  isAgentVisibility,
} from "@/features/agents/agent-visibility";

describe("AGENT_VISIBILITY", () => {
  test("has exactly public and private", () => {
    expect(AGENT_VISIBILITY).toEqual({ PUBLIC: "public", PRIVATE: "private" });
    expect(AGENT_VISIBILITY_VALUES).toEqual(["public", "private"]);
  });

  test("isAgentVisibility recognizes only the two declared values", () => {
    expect(isAgentVisibility("public")).toBeTrue();
    expect(isAgentVisibility("private")).toBeTrue();
    expect(isAgentVisibility("PUBLIC")).toBeFalse();
    expect(isAgentVisibility("")).toBeFalse();
    expect(isAgentVisibility("hidden")).toBeFalse();
  });
});
