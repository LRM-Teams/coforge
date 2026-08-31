import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const harness = await readFile(new URL("./run-computer-setup.sh", import.meta.url), "utf8");

test("Computer setup harness exercises the compiled CLI and real daemon path", () => {
  expect(harness).toContain("dist/coforge-computer");
  expect(harness).toContain("dist/coforge-daemon");
  expect(harness).toContain("COFORGE_SETUP_INTENT");
  expect(harness).toContain("COFORGE_E2E_ALLOW_DEVICE_AUTH=1");
  expect(harness).toContain("computer:register");
  expect(harness).toContain("wait-for-online");
  expect(harness).not.toContain("InMemoryDaemon");
  expect(harness).not.toContain("TRUNCATE");
});
