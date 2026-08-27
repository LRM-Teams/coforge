import { expect, test } from "bun:test";
import { ComputerRegistrationClient } from "./index";

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
        daemonWorkspaceCredential: "secret",
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
