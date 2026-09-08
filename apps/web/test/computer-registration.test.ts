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

test("registration replaces an untouched migration placeholder", async () => {
  const computer = { id: "c", ownerId: "u", machineId: "m", name: "", displayName: "" };
  await registerExistingComputer(computer);
  expect(computer).toMatchObject({ name: request.name, displayName: request.displayName });
});

test("registration preserves an edited display name even when it equals the former placeholder", async () => {
  const computer = {
    id: "c",
    ownerId: "u",
    machineId: "m",
    name: "old-host",
    displayName: "Computer",
  };
  await registerExistingComputer(computer);
  expect(computer).toMatchObject({ name: request.name, displayName: "Computer" });
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

async function registerExistingComputer(computer: {
  id: string;
  ownerId: string;
  machineId: string;
  name: string;
  displayName: string;
}): Promise<void> {
  const transaction = {
    computer: {
      updateMany: async ({
        where,
        data,
      }: {
        where: typeof computer;
        data: Partial<typeof computer>;
      }) => {
        if (
          Object.entries(where).every(
            ([key, value]) => computer[key as keyof typeof computer] === value,
          )
        )
          Object.assign(computer, data);
      },
      upsert: async ({ update }: { update: Partial<typeof computer> }) => {
        Object.assign(computer, update);
        return computer;
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
}
