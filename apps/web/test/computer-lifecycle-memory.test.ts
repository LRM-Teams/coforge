import { expect, test } from "bun:test";

import { RedisComputerLifecycleMemory } from "#src/server/computers/computer-lifecycle-memory.server";

const scope = { workspaceId: "workspace-1", computerId: "computer-1" };

/** The two Redis commands the memory uses, with their documented semantics: `SET … GET` answers
 * the value it replaced, `GETDEL` the value it removed. */
function fakeRedis() {
  const values = new Map<string, string>();
  const commands: string[][] = [];
  return {
    commands,
    redis: {
      send: async (command: "SET" | "GETDEL", args: string[]) => {
        commands.push([command, ...args]);
        const [key, value] = args as [string, string];
        const previous = values.get(key) ?? null;
        if (command === "GETDEL") values.delete(key);
        else values.set(key, value);
        return command === "GETDEL" || args.includes("GET") ? previous : "OK";
      },
    },
  };
}

test("a shutdown reason is kept for 30 minutes and read once", async () => {
  const { redis, commands } = fakeRedis();
  const memory = new RedisComputerLifecycleMemory(redis);

  await memory.rememberShutdown(scope, "computer_upgrade");

  expect(commands[0]).toEqual([
    "SET",
    "coforge:workspace:workspace-1:computer:computer-1:shutdown:v1",
    "computer_upgrade",
    "EX",
    "1800",
  ]);
  expect(await memory.takeShutdown(scope)).toBe("computer_upgrade");
  expect(await memory.takeShutdown(scope)).toBeUndefined();
});

test("each daemon instance's return is claimed once, and names the version the one before ran", async () => {
  const { redis } = fakeRedis();
  const memory = new RedisComputerLifecycleMemory(redis);

  expect(
    await memory.claimReturn(scope, { workerInstanceId: "worker-1", computerVersion: "1.0.0" }),
  ).toEqual({ first: true });
  expect(
    await memory.claimReturn(scope, { workerInstanceId: "worker-1", computerVersion: "1.0.0" }),
  ).toEqual({ first: false });
  expect(
    await memory.claimReturn(scope, { workerInstanceId: "worker-2", computerVersion: "1.1.0" }),
  ).toEqual({ first: true, previousComputerVersion: "1.0.0" });
});
