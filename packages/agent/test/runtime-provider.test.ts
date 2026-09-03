import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER_CONFIG_ENV, seedPiSessionModelRuntime } from "../src/runtime-provider";

test("installs and removes the launch-only Pi provider API key", async () => {
  const calls: unknown[] = [];
  const environment: Record<string, string | undefined> = {
    [RUNTIME_PROVIDER_CONFIG_ENV]: JSON.stringify({
      kind: "pi-builtin",
      providerId: "deepseek",
      apiKey: "sk-deepseek-secret",
    }),
  };

  await seedPiSessionModelRuntime(
    {
      async setRuntimeApiKey(...args: unknown[]) {
        calls.push(args);
      },
    },
    environment,
  );

  expect(environment).not.toHaveProperty(RUNTIME_PROVIDER_CONFIG_ENV);
  expect(calls).toEqual([["deepseek", "sk-deepseek-secret"]]);
});

test("removes and rejects an incomplete Pi provider config", async () => {
  const environment: Record<string, string | undefined> = {
    [RUNTIME_PROVIDER_CONFIG_ENV]: JSON.stringify({
      kind: "pi-builtin",
      providerId: "deepseek",
    }),
  };

  await expect(
    seedPiSessionModelRuntime({ setRuntimeApiKey: async () => {} }, environment),
  ).rejects.toThrow("Runtime provider config is invalid");
  expect(environment).not.toHaveProperty(RUNTIME_PROVIDER_CONFIG_ENV);
});
