import { expect, test } from "bun:test";
import { withRuntimeEnvironment } from "../src/runtime-provider";

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
