import { expect, test } from "bun:test";
import {
  RUNTIME_PROVIDER_CONFIG_ENV,
  seedPiSessionModelRuntime,
  withRuntimeEnvironment,
} from "../src/runtime-provider";

test("installs and removes the launch-only Pi provider API key", async () => {
  const calls: unknown[] = [];
  const environment: Record<string, string | undefined> = {
    [RUNTIME_PROVIDER_CONFIG_ENV]: JSON.stringify({
      kind: "coforge",
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
      kind: "coforge",
      providerId: "deepseek",
    }),
  };

  await expect(
    seedPiSessionModelRuntime({ setRuntimeApiKey: async () => {} }, environment),
  ).rejects.toThrow("Runtime provider config is invalid");
  expect(environment).not.toHaveProperty(RUNTIME_PROVIDER_CONFIG_ENV);
});

test("isolates provider credentials while the SDK is created and restores the host environment", async () => {
  const previousProviderKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "host-provider-key";
  try {
    await withRuntimeEnvironment({ COFORGE_TEST_RUNTIME_VALUE: "visible" }, async () => {
      expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
      expect(process.env.COFORGE_TEST_RUNTIME_VALUE).toBe("visible");
    });
    expect(process.env.OPENROUTER_API_KEY).toBe("host-provider-key");
  } finally {
    if (previousProviderKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousProviderKey;
    delete process.env.COFORGE_TEST_RUNTIME_VALUE;
  }
});
