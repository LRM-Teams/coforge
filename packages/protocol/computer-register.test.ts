import { expect, test } from "bun:test";
import { ComputerRegistrationClient, RUNTIME_PROVIDER } from "./index";
import { decodeComputerRegisterRequest, encodeComputerRegisterRequest } from "./codec";

test("computer registration sends the stable method and rejects incompatible majors", async () => {
  const calls: unknown[] = [];
  const client = new ComputerRegistrationClient({
    async request(method, payload) {
      calls.push([method, payload]);
      return {
        protocolMajor: 1,
        requestId: payload.requestId,
        computerId: "c",
        workspaceId: "w",
        connectionId: "b",
        workspaceWorkerToken: "secret",
      };
    },
  });
  const request = {
    protocolMajor: 1,
    requestId: "r",
    workspaceSlug: "team",
    machineId: "m",
    platform: "linux",
    osVersion: "1",
    computerVersion: "1",
    runtimes: [],
    registrationIdempotencyKey: "i",
  };
  await expect(client.register(request)).resolves.toMatchObject({ connectionId: "b" });
  expect(calls[0]).toMatchObject(["computer:register", request]);
  expect(() => client.register({ ...request, protocolMajor: 2 })).toThrow("unsupported");
});

test("registration codec encodes builtin and external kinds explicitly", () => {
  const request = {
    protocolMajor: 1,
    requestId: "r",
    workspaceSlug: "team",
    machineId: "m",
    platform: "linux",
    osVersion: "1",
    computerVersion: "1",
    registrationIdempotencyKey: "i",
    runtimes: [{ provider: RUNTIME_PROVIDER.PI, version: "1", kind: "builtin" as const }],
  } satisfies Parameters<ComputerRegistrationClient["register"]>[0];
  expect(decodeComputerRegisterRequest(encodeComputerRegisterRequest(request)).runtimes).toEqual(
    request.runtimes,
  );
  const external = { ...request.runtimes[0], kind: "external" as const };
  const externalPayload = encodeComputerRegisterRequest({
    ...request,
    runtimes: [external],
  });
  expect(decodeComputerRegisterRequest(externalPayload).runtimes).toEqual([external]);

  // Simulate a pre-kind payload by removing RuntimeMetadata.kind (field 4,
  // wire bytes 0x20 0x02) while retaining the request's later fields.
  const kindFieldOffset = externalPayload.lastIndexOf(0x20);
  const runtimesFieldOffset = externalPayload.lastIndexOf(0x42, kindFieldOffset);
  const oldPayload = new Uint8Array([
    ...externalPayload.slice(0, kindFieldOffset),
    ...externalPayload.slice(kindFieldOffset + 2),
  ]);
  oldPayload[runtimesFieldOffset + 1] -= 2;
  expect(decodeComputerRegisterRequest(oldPayload).runtimes[0].kind).toBe("external");
});

test("provider and kind together identify runtimes", () => {
  const runtimes = [
    { provider: RUNTIME_PROVIDER.PI, version: "builtin", kind: "builtin" as const },
    { provider: RUNTIME_PROVIDER.PI, version: "1.0.0", kind: "external" as const },
  ];
  expect(runtimes.map(({ provider, kind }) => `${provider}:${kind}`)).toEqual([
    "pi:builtin",
    "pi:external",
  ]);
});
