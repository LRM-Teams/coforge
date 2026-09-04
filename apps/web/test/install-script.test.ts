import { expect, test } from "bun:test";

import { isNonLocalizedRequest } from "../src/server";
import { installPs1Handler, installShHandler } from "../src/server/install/install-script.server";

test("the installer script paths bypass Paraglide localization (never 307-redirected)", () => {
  expect(isNonLocalizedRequest(new Request("http://localhost/computer/install.sh"))).toBe(true);
  expect(isNonLocalizedRequest(new Request("http://localhost/computer/install.ps1"))).toBe(true);
  // A locale-prefixed variant is not a documented entry point and is not exempted from this
  // predicate - it still goes through paraglideMiddleware, which (verified against the built
  // server) de-localizes it back to this same route and serves it too. That is harmless (nobody
  // links to it) and out of scope to prevent; this assertion only pins isNonLocalizedRequest's
  // own behavior, not what paraglideMiddleware later does with a `false` result.
  expect(isNonLocalizedRequest(new Request("http://localhost/en/computer/install.sh"))).toBe(false);
});

test("GET /computer/install.sh returns 200 plain text starting with the POSIX shebang", async () => {
  const response = installShHandler();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  const body = await response.text();
  expect(body.startsWith("#!/bin/sh")).toBe(true);
  // The exact bytes served must be install.sh's own bytes, not a copy that can drift from the
  // file scripts/release/install.test.ts and shellcheck actually exercise.
  const source = await Bun.file(
    new URL("../../../scripts/release/install.sh", import.meta.url),
  ).text();
  expect(body).toBe(source);
});

test("GET /computer/install.ps1 returns 200 plain text", async () => {
  const response = installPs1Handler();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  const body = await response.text();
  expect(body.length).toBeGreaterThan(0);
  const source = await Bun.file(
    new URL("../../../scripts/release/install.ps1", import.meta.url),
  ).text();
  expect(body).toBe(source);
});
