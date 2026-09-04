import { expect, test } from "bun:test";
import { parseArgs, run } from "../index";

test("message check has no target arguments", () => {
  expect(parseArgs(["message", "check"])).toEqual({ command: "check" });
  expect(() => parseArgs(["message", "check", "--target", "@ada"])).toThrow("Usage:");
});

test.each(["read", "send"] as const)("requires an explicit target for message %s", (command) => {
  expect(() => parseArgs(["message", command])).toThrow("Usage:");
  expect(parseArgs(["message", command, "--target", "@ada"])).toEqual({
    command,
    target: "@ada",
  });
});

test("App Inbox exposes check without a generic acknowledgement command", () => {
  expect(parseArgs(["inbox", "check"])).toEqual({ command: "inbox-check" });
  expect(() => parseArgs(["inbox", "ack", "--item", "reminder:id:1"])).toThrow("Usage:");
});

test("dispatches Inbox check without message operations", async () => {
  const calls: string[] = [];
  const transport = {
    check: async () => {
      throw new Error("message check called");
    },
    read: async () => {
      throw new Error("message read called");
    },
    send: async () => {
      throw new Error("message send called");
    },
    view: async () => {
      throw new Error("attachment called");
    },
    inboxCheck: async () => calls.push("check"),
  };
  await run(["inbox", "check"], transport);
  expect(calls).toEqual(["check"]);
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

test("parses a held draft retry", () => {
  expect(() => parseArgs(["message", "send", "--send-draft"])).toThrow("Usage:");
  expect(parseArgs(["message", "send", "--send-draft", "--anyway", "--target", "@ada"])).toEqual({
    command: "send",
    target: "@ada",
    sendDraft: true,
    continueAnyway: true,
  });
  expect(() => parseArgs(["message", "send", "--anyway", "--target", "@ada"])).toThrow("Usage:");
});

test("dispatches only through the injected transport seam", async () => {
  const calls: string[] = [];
  await expect(
    run(["message", "read", "--target", "@ada"], {
      check: async () => {
        throw new Error("unused");
      },
      read: async (target) => {
        calls.push(`read:${target}`);
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
  expect(calls).toEqual(["read:@ada"]);
});

test("message check hides server ordering fields", async () => {
  const output = await run(["message", "check"], {
    check: async () => ({
      accepted: true,
      messages: [
        {
          id: "message-7",
          sequence: 7,
          sender: "@ada",
          target: "@ada",
          body: "Can you investigate?",
          createdAt: "2026-09-03T10:00:00Z",
        },
      ],
    }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
  });

  expect(output).toBe(
    "[target=@ada time=2026-09-03T10:00:00Z] @ada: Can you investigate?\n\nNo more new inbox messages.",
  );
});

test("message check says plainly when there are no pending messages", async () => {
  const output = await run(["message", "check"], {
    check: async () => ({ accepted: true, messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
  });

  expect(output).toBe("No new inbox messages.");
});

test("message read hides server ordering fields", async () => {
  const output = await run(["message", "read", "--target", "@ada"], {
    check: async () => ({ messages: [] }),
    read: async () => ({
      messages: [
        {
          id: "message-1",
          sequence: 42,
          sender: "@ada",
          target: "@ada",
          body: "hello",
          createdAt: "2026-09-03T10:00:00Z",
        },
      ],
      hasOlder: false,
      hasNewer: false,
    }),
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
  });

  expect(output).not.toContain("sequence");
  expect(output).toContain('"id":"message-1"');
});

test("App Inbox hides message ordering fields from Agent output", async () => {
  const output = await run(["inbox", "check"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
    inboxCheck: async () => ({
      entries: [
        {
          kind: "message_target",
          messageTarget: {
            target: "@ada",
            pendingCount: 2,
            firstPendingSequence: 7,
            latestSequence: 8,
            flags: ["dm"],
          },
        },
      ],
    }),
  });

  expect(output).not.toContain("firstPendingSequence");
  expect(output).not.toContain("latestSequence");
  expect(output).toContain('"pendingCount":2');
});

test("held send results hide message ordering fields from Agent output", async () => {
  const output = await run(["message", "send", "--target", "@ada"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => ({
      accepted: false,
      sideEffectDecision: "hold",
      messages: [{ id: "message-2", sequence: 9, body: "new context" }],
    }),
    view: async () => ({ bytes: new Uint8Array() }),
  });

  expect(output).not.toContain("sequence");
  expect(output).toContain('"id":"message-2"');
});

test("send results hide the internal model cursor from Agent output", async () => {
  const output = await run(["message", "send", "--target", "@ada", "--send-draft"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => ({
      accepted: true,
      messageId: "message-sent",
      seenUpToSequence: 9,
      messages: [],
    }),
    view: async () => ({ bytes: new Uint8Array() }),
  });

  expect(output).not.toContain("seenUpToSequence");
  expect(output).not.toContain("9");
});
