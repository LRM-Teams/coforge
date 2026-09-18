import { describe, expect, test } from "bun:test";
import { updateAgentInputFromForm } from "../src/features/agents/agent-form";
import {
  createAgentInputSchema,
  updateAgentInputSchema,
} from "../src/features/agents/agent.schemas";

const validInput = {
  name: "release-helper",
  description: "Builds and releases the project.",
  provider: "coforge" as const,
  computerId: "computer-1",
};

const validUpdate = {
  agentId: "6f81050c-6ff3-4f17-b5f8-dc8eed8ea5da",
  description: "Builds and releases the project.",
  provider: "coforge" as const,
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

  test("strips a displayName from create input; the create shape has no such field", () => {
    expect(
      createAgentInputSchema.parse({ ...validInput, displayName: "周报 Helper" }),
    ).not.toHaveProperty("displayName");
  });

  test("defaults omitted and blank descriptions to an empty string", () => {
    const { description: _, ...withoutDescription } = validInput;
    const { description: __, ...updateWithoutDescription } = validUpdate;

    expect(createAgentInputSchema.parse(withoutDescription).description).toBe("");
    expect(createAgentInputSchema.parse({ ...validInput, description: "   " }).description).toBe(
      "",
    );
    expect(updateAgentInputSchema.parse(updateWithoutDescription).description).toBe("");
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
        modelProvider: " deepseek ",
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
        modelProvider: "deepseek",
        apiKey: "short",
      }).success,
    ).toBe(false);
  });

  test("applies API key validation independently to updates", () => {
    const update = {
      ...validUpdate,
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
        ...validUpdate,
        provider: "pi",
        modelProvider: "custom-unsupported",
        apiKey: "fixture-key",
      }).success,
    ).toBe(false);
  });

  test("rejects a Pi API key for zai: CoForge's keyed catalog carries it, but Pi's picker offers only DeepSeek and OpenRouter as built-in providers", () => {
    expect(
      createAgentInputSchema.safeParse({
        ...validInput,
        provider: "pi",
        modelProvider: "zai",
        apiKey: "fixture-key",
      }).success,
    ).toBe(false);
    expect(
      updateAgentInputSchema.safeParse({
        ...validUpdate,
        provider: "pi",
        modelProvider: "zai",
        apiKey: "fixture-key",
      }).success,
    ).toBe(false);
  });

  test("accepts a Pi API key for DeepSeek and OpenRouter, the Pi built-in provider set", () => {
    expect(
      createAgentInputSchema.safeParse({
        ...validInput,
        provider: "pi",
        modelProvider: "deepseek",
        apiKey: "fixture-key",
      }).success,
    ).toBe(true);
    expect(
      createAgentInputSchema.safeParse({
        ...validInput,
        provider: "pi",
        modelProvider: "openrouter",
        apiKey: "fixture-key",
      }).success,
    ).toBe(true);
  });

  test("strips a name from update input, even if one is supplied; the handle can't be renamed", () => {
    expect(updateAgentInputSchema.parse({ ...validUpdate, name: "renamed" })).not.toHaveProperty(
      "name",
    );
  });

  test("accepts a free-text displayName on update, independent of the handle charset", () => {
    expect(
      updateAgentInputSchema.parse({ ...validUpdate, displayName: "周报 Helper" }).displayName,
    ).toBe("周报 Helper");
  });

  test("preprocesses a blank or whitespace-only displayName to undefined", () => {
    expect(
      updateAgentInputSchema.parse({ ...validUpdate, displayName: "" }).displayName,
    ).toBeUndefined();
    expect(
      updateAgentInputSchema.parse({ ...validUpdate, displayName: "   " }).displayName,
    ).toBeUndefined();
  });

  test("accepts a displayName up to 80 characters and rejects longer", () => {
    expect(
      updateAgentInputSchema.safeParse({ ...validUpdate, displayName: "x".repeat(80) }).success,
    ).toBe(true);
    expect(
      updateAgentInputSchema.safeParse({ ...validUpdate, displayName: "x".repeat(81) }).success,
    ).toBe(false);
  });

  test("omitting displayName on update is valid", () => {
    expect(updateAgentInputSchema.parse(validUpdate).displayName).toBeUndefined();
  });

  test("forwards a CoForge API key from the Agent edit form", () => {
    const agentId = "6f81050c-6ff3-4f17-b5f8-dc8eed8ea5da";
    const computerId = "8c2b1a70-2d11-4f0e-9c3a-1f6e0b9d4a21";
    const form = new FormData();
    form.set("description", "");
    form.set("provider", "coforge");
    form.set("modelProvider", "openai");
    form.set("model", "gpt-5");
    form.set("reasoning", "");
    form.set("computerId", computerId);
    form.set("apiKey", "sk-assistant-runtime-key");
    form.set("displayName", "周报助手");
    expect(updateAgentInputSchema.parse(updateAgentInputFromForm(form, { agentId }))).toMatchObject(
      {
        agentId,
        provider: "coforge",
        modelProvider: "openai",
        apiKey: "sk-assistant-runtime-key",
        displayName: "周报助手",
        computerId,
      },
    );
  });

  test("never emits a name from the update form payload, even if the form carries one", () => {
    const agentId = "6f81050c-6ff3-4f17-b5f8-dc8eed8ea5da";
    const form = new FormData();
    form.set("name", "release-helper");
    form.set("description", "");
    form.set("provider", "coforge");
    expect(updateAgentInputFromForm(form, { agentId })).not.toHaveProperty("name");
  });

  test("omits displayName from the update form payload when left blank", () => {
    const agentId = "6f81050c-6ff3-4f17-b5f8-dc8eed8ea5da";
    const form = new FormData();
    form.set("description", "");
    form.set("provider", "coforge");
    expect(updateAgentInputFromForm(form, { agentId })).not.toHaveProperty("displayName");
  });
});
