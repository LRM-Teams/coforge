import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { parseArgs, run, type MessageTransport } from "../index";
import { CliError } from "../src/cli-error";
import { connectLocal } from "../src/local-client";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";

afterEach(() => {
  mock.restore();
});

const noopTransport: MessageTransport = {
  check: async () => ({ messages: [] }),
  read: async () => ({ messages: [] }),
  send: async () => ({ accepted: true }),
  view: async () => ({ bytes: new Uint8Array() }),
};

// --- parseArgs -------------------------------------------------------------

test("parseArgs parses 'action prepare --target <target>'", () => {
  expect(parseArgs(["action", "prepare", "--target", "#general"])).toEqual({
    command: "action-prepare",
    target: "#general",
  });
});

test("parseArgs rejects 'action prepare' with no --target", () => {
  const error = (() => {
    try {
      parseArgs(["action", "prepare"]);
      return undefined;
    } catch (thrown) {
      return thrown;
    }
  })();
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("INVALID_ARG");
  expect((error as CliError).message).toBe("--target is required");
});

test("parseArgs rejects 'action prepare --target \"\"' (blank target)", () => {
  const error = (() => {
    try {
      parseArgs(["action", "prepare", "--target", "   "]);
      return undefined;
    } catch (thrown) {
      return thrown;
    }
  })();
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("INVALID_ARG");
});

test("parseArgs rejects an unknown flag on 'action prepare'", () => {
  expect(() => parseArgs(["action", "prepare", "--target", "#general", "--bogus"])).toThrow(
    CliError,
  );
});

test("the top-level usage string mentions 'coforge action prepare'", () => {
  expect(() => parseArgs(["nonsense"])).toThrow(/coforge action prepare --target <target>/);
});

// --- run(): stdin-independent error path ------------------------------------

test("run() reports a typed transport-unavailable error when actionPrepare is not wired", async () => {
  await expect(run(["action", "prepare", "--target", "#general"], noopTransport)).rejects.toThrow(
    "Action transport is unavailable",
  );
});

test("run() surfaces MISSING_ACTION when stdin is empty", async () => {
  // `Bun.stdin` is the one process-wide stdin stream; other test files (notably
  // `cli.test.ts`'s "message send" tests) read it too, so this stubs `.stream()` locally
  // instead of touching the real, singleton, single-read process stdin.
  const emptyStream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.close();
    },
  });
  const streamSpy = spyOn(Bun.stdin, "stream").mockReturnValue(emptyStream);
  const calls: unknown[] = [];
  const transport: MessageTransport = {
    ...noopTransport,
    actionPrepare: async (target, action) => {
      calls.push({ target, action });
      return {
        messageId: "11111111-1111-1111-1111-111111111111",
        metadata: { kind: "action-card" },
      };
    },
  };
  const error = await run(["action", "prepare", "--target", "#general"], transport).catch(
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("MISSING_ACTION");
  expect(streamSpy).toHaveBeenCalled();
  // The transport is never reached: validation happens before the call.
  expect(calls).toEqual([]);
});

// --- connectLocal().actionPrepare(): the local daemon proxy transport ------

test("actionPrepare posts {target, action} to the registered local proxy route", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      messageId: "11111111-1111-1111-1111-111111111111",
      metadata: { kind: "action-card" },
    }),
  );
  const action = { type: "channel:create" as const, name: "design", visibility: "public" as const };

  const result = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    `http://proxy.test${agentApiRoutes.local.actionPrepare.path}`,
  ).actionPrepare?.("#general", action);

  expect(result).toEqual({
    messageId: "11111111-1111-1111-1111-111111111111",
    metadata: { kind: "action-card" },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0]!;
  expect(new URL(url as string).pathname).toBe(agentApiRoutes.local.actionPrepare.path);
  expect(init?.method).toBe(agentApiRoutes.local.actionPrepare.method);
  const body = JSON.parse(init!.body as string);
  expect(body).toEqual({ target: "#general", action });
});

test("actionPrepare maps a 4xx proxy response to PREPARE_FAILED with the server's error text", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      { error: "INVALID_HANDLE", message: "unknown human handle: @nobody" },
      { status: 422 },
    ),
  );
  const action = { type: "agent:create" as const, name: "scout" };

  const error = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    `http://proxy.test${agentApiRoutes.local.actionPrepare.path}`,
  )
    .actionPrepare?.("#general", action)
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("PREPARE_FAILED");
  expect((error as CliError).message).toBe("unknown human handle: @nobody");
});

test("actionPrepare maps a 5xx proxy response to SERVER_5XX", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 502 }));
  const action = { type: "agent:create" as const, name: "scout" };

  const error = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    `http://proxy.test${agentApiRoutes.local.actionPrepare.path}`,
  )
    .actionPrepare?.("#general", action)
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("SERVER_5XX");
});

test("actionPrepare maps a network failure to PREPARE_FAILED", async () => {
  spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
  const action = { type: "agent:create" as const, name: "scout" };

  const error = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    `http://proxy.test${agentApiRoutes.local.actionPrepare.path}`,
  )
    .actionPrepare?.("#general", action)
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("PREPARE_FAILED");
});
