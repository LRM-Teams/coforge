import { describe, expect, test } from "bun:test";
import { updateAgentInputFromForm } from "../src/features/agents/agent-form";
import {
  createAgentInputSchema,
  updateAgentInputSchema,
} from "../src/features/agents/agent.schemas";
import { weeklyReportAssistantAgentName } from "../src/server/records/weekly-report-assistant.server";

const validInput = {
  name: "release-helper",
  description: "Builds and releases the project.",
  provider: "coforge" as const,
  computerId: "computer-1",
};

describe("createAgentInputSchema", () => {
  test("accepts the public Agent creation shape", () => {
    expect(createAgentInputSchema.parse(validInput)).toEqual(validInput);
  });

  test("accepts Kiro with its default credential configuration", () => {
    expect(
      createAgentInputSchema.parse({
        ...validInput,
        provider: "kiro",
        model: "auto",
        reasoning: "high",
      }),
    ).toMatchObject({ provider: "kiro", model: "auto", reasoning: "high" });
  });

  test("trims values and accepts optional runtime settings", () => {
    expect(
      createAgentInputSchema.parse({
        ...validInput,
        name: "  release-helper ",
        description: " Builds and releases the project. ",
        model: " gpt-5 ",
        modelProvider: " openai ",
        reasoning: " high ",
      }),
    ).toMatchObject({
      name: "release-helper",
      description: "Builds and releases the project.",
      model: "gpt-5",
      modelProvider: "openai",
      reasoning: "high",
    });
  });

  test("defaults omitted and blank descriptions to an empty string", () => {
    const { description: _, ...withoutDescription } = validInput;

    expect(createAgentInputSchema.parse(withoutDescription).description).toBe("");
    expect(createAgentInputSchema.parse({ ...validInput, description: "   " }).description).toBe(
      "",
    );
    expect(
      updateAgentInputSchema.parse({
        ...withoutDescription,
        agentId: "6f81050c-6ff3-4f17-b5f8-dc8eed8ea5da",
      }).description,
    ).toBe("");
  });

  test("rejects invalid names, oversized descriptions, providers, and computers", () => {
    expect(
      createAgentInputSchema.safeParse({
        ...validInput,
        name: "Release Helper",
      }).success,
    ).toBe(false);
    expect(
      createAgentInputSchema.safeParse({ ...validInput, description: "x".repeat(501) }).success,
    ).toBe(false);
    expect(createAgentInputSchema.safeParse({ ...validInput, provider: "unknown" }).success).toBe(
      false,
    );
    expect(createAgentInputSchema.safeParse({ ...validInput, computerId: "" }).success).toBe(false);
  });

  test("normalizes supported runtime API keys and requires their model provider", () => {
    expect(
      createAgentInputSchema.parse({
        ...validInput,
        provider: "pi",
        modelProvider: " openai ",
        apiKey: "  secret-key  ",
      }).apiKey,
    ).toBe("secret-key");
    expect(
      createAgentInputSchema.parse({ ...validInput, provider: "pi", apiKey: "   " }).apiKey,
    ).toBeUndefined();
    expect(
      createAgentInputSchema.safeParse({ ...validInput, provider: "codex", apiKey: "secret-key" })
        .success,
    ).toBe(false);
    expect(
      createAgentInputSchema.safeParse({ ...validInput, provider: "pi", apiKey: "secret-key" })
        .success,
    ).toBe(false);
    expect(
      createAgentInputSchema.safeParse({
        ...validInput,
        provider: "pi",
        modelProvider: "openai",
        apiKey: "short",
      }).success,
    ).toBe(false);
  });

  test("applies API key validation independently to updates", () => {
    const update = {
      ...validInput,
      agentId: "6f81050c-6ff3-4f17-b5f8-dc8eed8ea5da",
      provider: "coforge" as const,
      modelProvider: "anthropic",
      apiKey: "replacement-key",
    };
    expect(updateAgentInputSchema.parse(update).apiKey).toBe("replacement-key");
  });

  test("rejects unsupported Pi key providers before creation or update", () => {
    const input = {
      ...validInput,
      provider: "pi",
      modelProvider: "custom-unsupported",
      apiKey: "fixture-key",
    };
    expect(createAgentInputSchema.safeParse(input).success).toBe(false);
    expect(
      updateAgentInputSchema.safeParse({
        ...input,
        agentId: "6f81050c-6ff3-4f17-b5f8-dc8eed8ea5da",
      }).success,
    ).toBe(false);
  });

  test("accepts the stable weekly-report assistant Agent name on update", () => {
    const userId = "7bd89875-1671-4866-9b4a-3da1522ef63b";
    const name = weeklyReportAssistantAgentName(userId);
    expect(name.length).toBeGreaterThan(48);
    expect(
      updateAgentInputSchema.parse({
        agentId: userId,
        name,
        description: "",
        provider: "pi",
        modelProvider: "anthropic",
        computerId: userId,
      }).name,
    ).toBe(name);
  });

  test("forwards a CoForge API key from the Agent edit form", () => {
    const agentId = "6f81050c-6ff3-4f17-b5f8-dc8eed8ea5da";
    const computerId = "8c2b1a70-2d11-4f0e-9c3a-1f6e0b9d4a21";
    const form = new FormData();
    form.set("name", weeklyReportAssistantAgentName(agentId));
    form.set("description", "");
    form.set("provider", "coforge");
    form.set("modelProvider", "openai");
    form.set("model", "gpt-5");
    form.set("reasoning", "");
    form.set("computerId", computerId);
    form.set("apiKey", "sk-assistant-runtime-key");
    expect(updateAgentInputSchema.parse(updateAgentInputFromForm(form, { agentId }))).toMatchObject(
      {
        agentId,
        provider: "coforge",
        modelProvider: "openai",
        apiKey: "sk-assistant-runtime-key",
        computerId,
      },
    );
  });
});
