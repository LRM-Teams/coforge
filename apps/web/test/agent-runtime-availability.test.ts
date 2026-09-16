import { describe, expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { agentRuntimeSelectionIsAvailable } from "../src/server/agents/agent-runtime-availability.server";

const gpt = {
  id: "gpt-5",
  modelProvider: "openai",
  reasoningEfforts: ["low", "high"],
};

describe("agentRuntimeSelectionIsAvailable", () => {
  test("allows CoForge with a model provider before a catalog model is chosen", () => {
    expect(
      agentRuntimeSelectionIsAvailable(
        {
          provider: RUNTIME_PROVIDER.COFORGE,
          model: "",
          modelProvider: "openai",
          reasoning: "",
          hasApiKey: true,
        },
        { connected: true, providers: new Set([RUNTIME_PROVIDER.COFORGE]), models: [] },
      ),
    ).toBe(true);
  });

  test("treats CoForge as available when the Computer only reports Pi", () => {
    expect(
      agentRuntimeSelectionIsAvailable(
        {
          provider: RUNTIME_PROVIDER.COFORGE,
          model: "gpt-5",
          modelProvider: "openai",
          reasoning: "",
          hasApiKey: true,
        },
        { connected: true, providers: new Set([RUNTIME_PROVIDER.PI]), models: [gpt] },
      ),
    ).toBe(true);
  });

  test("allows keyed Pi with a model provider before a catalog model is chosen", () => {
    expect(
      agentRuntimeSelectionIsAvailable(
        {
          provider: RUNTIME_PROVIDER.PI,
          model: "",
          modelProvider: "openai",
          reasoning: "",
          hasApiKey: true,
        },
        { connected: true, providers: new Set([RUNTIME_PROVIDER.PI]), models: [] },
      ),
    ).toBe(true);
  });

  test("rejects a runtime the Computer does not expose", () => {
    expect(
      agentRuntimeSelectionIsAvailable(
        {
          provider: RUNTIME_PROVIDER.CODEX,
          model: "",
          modelProvider: "",
          reasoning: "",
          hasApiKey: false,
        },
        { connected: true, providers: new Set([RUNTIME_PROVIDER.PI]), models: [] },
      ),
    ).toBe(false);
  });

  test("rejects when the Computer is not connected to the Workspace", () => {
    expect(
      agentRuntimeSelectionIsAvailable(
        {
          provider: RUNTIME_PROVIDER.COFORGE,
          model: "",
          modelProvider: "openai",
          reasoning: "",
          hasApiKey: true,
        },
        { connected: false, providers: new Set(), models: [] },
      ),
    ).toBe(false);
  });
});
