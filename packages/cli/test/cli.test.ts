import { expect, test } from "bun:test";
import { parseArgs, run } from "../index";

test.each(["check", "read", "send"] as const)("parses message %s", (command) => {
  expect(parseArgs(["message", command])).toEqual({ command });
});

test("parses attachment view with an output path", () => {
  expect(parseArgs(["attachment", "view", "attachment-1", "--output", "/tmp/file.txt"])).toEqual({
    command: "attachment-view",
    attachmentId: "attachment-1",
    output: "/tmp/file.txt",
  });
});

test("rejects agent-internal arguments", () => {
  expect(() => parseArgs(["message", "send", "agent-1"])).toThrow("Usage:");
});

test("dispatches only through the injected transport seam", async () => {
  const calls: string[] = [];
  await expect(
    run(["message", "read"], {
      check: async () => {
        throw new Error("unused");
      },
      read: async () => {
        calls.push("read");
        throw new Error("injected transport failure");
      },
      send: async () => {
        throw new Error("unused");
      },
      view: async () => {
        throw new Error("unused");
      },
    }),
  ).rejects.toThrow("injected transport failure");
  expect(calls).toEqual(["read"]);
});
