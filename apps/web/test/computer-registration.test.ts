import { expect, test } from "bun:test";
import { ComputerRegistrar } from "../src/server/computers/registration.server";
import type { ComputerRegisterRequest } from "@coforge/protocol";

const request: ComputerRegisterRequest = {
  protocolMajor: 1,
  requestId: "r",
  workspaceSlug: "team",
  machineId: "m",
  platform: "linux",
  osVersion: "1",
  computerVersion: "1",
  runtimes: [],
  registrationIdempotencyKey: "retry-key",
};

test("retries reuse the unique binding and receive a fresh stateless JWT", async () => {
  let calls = 0;
  const registrar = new ComputerRegistrar({
    workspaceAccess: { findAccessibleBySlug: async () => ({ id: "w", slug: "team" }) },
    computers: { create: async () => ({ computerId: "c", workspaceId: "w" }) },
    tokenIssuer: { issue: async () => `jwt-${++calls}` },
  });
  const first = await registrar.register(request, { userId: "u" });
  const second = await registrar.register(request, { userId: "u" });
  expect(first.daemonToken).toBe("jwt-1");
  expect(second.daemonToken).toBe("jwt-2");
});

test("rejects unauthenticated or inaccessible setup", async () => {
  const registrar = new ComputerRegistrar({
    workspaceAccess: { findAccessibleBySlug: async () => undefined },
    computers: { create: async () => ({ computerId: "c", workspaceId: "w" }) },
    tokenIssuer: { issue: async () => "jwt" },
  });
  await expect(registrar.register(request, undefined)).rejects.toMatchObject({ code: 401 });
  await expect(registrar.register(request, { userId: "u" })).rejects.toMatchObject({ code: 403 });
});
