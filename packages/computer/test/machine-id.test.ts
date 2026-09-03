import { expect, test } from "bun:test";

import { resolveMachineId } from "../src/machine-id";

test("macOS machine id comes from IOPlatformUUID", async () => {
  await expect(
    resolveMachineId({
      platform: "darwin",
      run: async () => '"IOPlatformUUID" = "MAC-UUID"',
      fallback: { load: async () => null, save: async () => undefined },
    }),
  ).resolves.toBe("macos:mac-uuid");
});

test("Linux machine id comes from /etc/machine-id", async () => {
  await expect(
    resolveMachineId({
      platform: "linux",
      readFile: async () => "linux-machine-id\n",
      fallback: { load: async () => null, save: async () => undefined },
    }),
  ).resolves.toBe("linux:linux-machine-id");
});

test("fallback id is generated once and reused", async () => {
  let saved: string | null = null;
  const options = {
    platform: "darwin" as const,
    run: async () => "",
    fallback: {
      load: async () => saved,
      save: async (value: string) => {
        saved = value;
      },
    },
  };

  const first = await resolveMachineId(options);
  const second = await resolveMachineId(options);

  expect(first).toMatch(/^fallback:[0-9a-f-]{36}$/);
  expect(second).toBe(first);
});
