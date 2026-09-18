import { expect, test } from "bun:test";

import { modelProviderDisplayName } from "@/features/agents/model-provider-display";

test("known model providers use their brand names", () => {
  expect(modelProviderDisplayName("zai-coding-cn")).toBe("Z.AI Coding CN");
  expect(modelProviderDisplayName("openrouter")).toBe("OpenRouter");
  expect(modelProviderDisplayName("openai")).toBe("OpenAI");
});

test("a Computer's own provider ids are humanized", () => {
  expect(modelProviderDisplayName("lenovo-deepseek-v4")).toBe("Lenovo DeepSeek V4");
  expect(modelProviderDisplayName("lenovo-qwen35")).toBe("Lenovo Qwen35");
  expect(modelProviderDisplayName("cc-club")).toBe("Cc Club");
  expect(modelProviderDisplayName("modelfactory")).toBe("Modelfactory");
  expect(modelProviderDisplayName("openai-codex")).toBe("OpenAI Codex");
});
