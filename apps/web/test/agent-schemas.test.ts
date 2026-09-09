import { describe, expect, test } from "bun:test";
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
});
