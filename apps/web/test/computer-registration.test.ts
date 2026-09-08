import { expect, test } from "bun:test";
import { ComputerRegistrar } from "../src/server/computers/registration.server";
import type { ComputerRegisterRequest } from "@coforge/protocol";
import type { PrismaClient } from "../generated/client";
import { PrismaComputerRegistrationRepository } from "../src/server/db/repositories/setup.repositories.server";

const request: ComputerRegisterRequest = {
  protocolMajor: 1,
  requestId: "r",
  workspaceSlug: "team",
  name: "franks-macbook-pro",
  displayName: "Frank’s MacBook Pro",
  machineId: "m",
  platform: "linux",
  osVersion: "1",
  computerVersion: "1",
  registrationIdempotencyKey: "retry-key",
};

test("retries reuse the unique binding and receive a fresh Daemon API key", async () => {
  let calls = 0;
  const registrar = new ComputerRegistrar({
    workspaceAccess: {
      findAccessibleBySlug: async () => ({ id: "w", slug: "team" }),
    },
    registrations: {
      register: async () => ({
        computerId: "c",
        workspaceId: "w",
        daemonApiKey: `dk_test_${++calls}`,
      }),
    },
  });
  const first = await registrar.register(request, { userId: "u" });
  const second = await registrar.register(request, { userId: "u" });
  expect(first.daemonApiKey).toBe("dk_test_1");
  expect(second.daemonApiKey).toBe("dk_test_2");
});

test("registration refreshes the hostname without overwriting an edited display name", async () => {
  let upsert: unknown;
  const transaction = {
    computer: {
      upsert: async (args: unknown) => {
        upsert = args;
        return { id: "c" };
      },
    },
    workspaceComputer: { upsert: async () => undefined },
    daemonApiKey: {
      updateMany: async () => undefined,
      create: async () => undefined,
    },
  };
  const db = {
    $transaction: async (execute: (tx: typeof transaction) => Promise<unknown>) =>
      execute(transaction),
  } as unknown as PrismaClient;

  await new PrismaComputerRegistrationRepository(db).register({
    principal: { userId: "u" },
    workspace: { id: "w", slug: "team" },
    request,
  });

  expect(upsert).toMatchObject({
    create: { name: request.name, displayName: request.displayName },
    update: { name: request.name },
  });
  expect(upsert).not.toMatchObject({ update: { displayName: expect.anything() } });
});

test("rejects unauthenticated or inaccessible setup", async () => {
  const registrar = new ComputerRegistrar({
    workspaceAccess: { findAccessibleBySlug: async () => undefined },
    registrations: {
      register: async () => ({
        computerId: "c",
        workspaceId: "w",
        daemonApiKey: "dk_test",
      }),
    },
  });
  await expect(registrar.register(request, undefined)).rejects.toMatchObject({
    code: 401,
  });
  await expect(registrar.register(request, { userId: "u" })).rejects.toMatchObject({ code: 403 });
});
