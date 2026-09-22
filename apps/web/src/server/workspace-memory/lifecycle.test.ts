import { expect, test } from "bun:test";

test("Centrifugo RPC composition no longer starts the memory sweep", async () => {
  const text = await Bun.file(
    new URL("../centrifugo/rpc-composition.server.ts", import.meta.url),
  ).text();
  expect(text).not.toMatch(/ensureCausalAdmissionSweep|ensureWorkspaceMemoryLifecycle/);
});

test("the backend server entry owns the memory lifecycle", async () => {
  const text = await Bun.file(new URL("../../server.ts", import.meta.url)).text();
  expect(text).toMatch(/ensureWorkspaceMemoryLifecycle/);
});
