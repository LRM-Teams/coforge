import { describe, expect, test } from "bun:test";
import { createAgentInputSchema } from "../src/features/agents/agent.schemas";

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
      model: " gpt-5 ",
      modelProvider: " openai ",
      reasoning: " high ",
    });
  });

  test("rejects invalid names, descriptions, providers, and computers", () => {
    expect(
      createAgentInputSchema.safeParse({ ...validInput, name: "Release Helper" }).success,
    ).toBe(false);
    expect(createAgentInputSchema.safeParse({ ...validInput, description: "" }).success).toBe(
      false,
    );
    expect(createAgentInputSchema.safeParse({ ...validInput, provider: "unknown" }).success).toBe(
      false,
    );
    expect(createAgentInputSchema.safeParse({ ...validInput, computerId: "" }).success).toBe(false);
  });
});
