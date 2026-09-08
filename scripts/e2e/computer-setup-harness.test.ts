import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const harness = await readFile(new URL("./run-computer-setup.sh", import.meta.url), "utf8");
const fixtureBuild = await readFile(
  new URL("./build-computer-fixture.ts", import.meta.url),
  "utf8",
);
const waitForOnline = await readFile(new URL("./wait-for-online.sh", import.meta.url), "utf8");
const managedInfra = await readFile(new URL("./managed-infra.sh", import.meta.url), "utf8");
const managedWeb = await readFile(new URL("./managed-web.sh", import.meta.url), "utf8");

test("Computer setup harness exercises the compiled CLI and real daemon path", () => {
  expect(harness).toContain(".amp/e2e/bin/coforge-computer");
  expect(harness).toContain(".amp/e2e/bin/coforge-daemon");
  expect(harness).toContain("build-computer-fixture.ts");
  expect(harness).toContain("COFORGE_SETUP_INTENT");
  expect(harness).toContain("COFORGE_E2E_ALLOW_DEVICE_AUTH=1");
  expect(harness).toContain("provider_home in .codex .claude");
  expect(harness).toContain('export HOME="$COFORGE_E2E_HOME"');
  expect(harness).not.toContain("setup --server");
  expect(fixtureBuild).toContain("COFORGE_E2E_WEB_URL");
  expect(fixtureBuild).toContain("COFORGE_E2E_CENTRIFUGO_ENDPOINT");
  expect(fixtureBuild).toContain("COFORGE_SERVER_URL");
  expect(fixtureBuild).toContain("COFORGE_DAEMON_SERVER_URL");
  expect(harness).toContain("computer:register");
  expect(harness).toContain("wait-for-online");
  expect(harness).toContain("e2e-provider-usage.ts");
  expect(harness).not.toContain("InMemoryDaemon");
  expect(harness).not.toContain("TRUNCATE");
});

test("Computer setup follows the localized computers redirect while waiting for Online", () => {
  expect(waitForOnline).toContain("--location");
});

test("Computer setup infrastructure keeps the normal fixed Centrifugo port", () => {
  expect(managedInfra).not.toContain("CENTRIFUGO_PORT");
});

test("managed Web seeds the fixed development user after database migration", () => {
  const migration = managedWeb.indexOf("db:migrate:deploy");
  const seed = managedWeb.indexOf("seed-dev-data.ts");

  expect(migration).toBeGreaterThan(-1);
  expect(seed).toBeGreaterThan(migration);
});

test("managed Web loads the stable local Web Push key pair", () => {
  expect(managedWeb).toContain("COFORGE_WEB_PUSH_PUBLIC_KEY");
  expect(managedWeb).toContain("COFORGE_WEB_PUSH_PRIVATE_KEY_FILE");
});
