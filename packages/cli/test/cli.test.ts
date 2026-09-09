import { expect, test } from "bun:test";
import { parseArgs, run } from "../index";

const reminderId = "12345678-1234-4123-8123-123456789abc";

test("parses recurring reminders with an explicit default timezone and dispatches them", async () => {
  const invocation = parseArgs([
    "reminder",
    "schedule",
    "--title",
    "Daily standup",
    "--target",
    "@ada:abcdef12",
    "--message-id",
    "deadbeef",
    "--repeat",
    "daily@09:30",
  ]);
  expect(invocation).toEqual({
    command: "reminder",
    operation: "schedule",
    title: "Daily standup",
    target: "@ada:abcdef12",
    messageId: "deadbeef",
    repeat: "daily@09:30",
    timezone: "Asia/Shanghai",
  });
  const calls: unknown[] = [];
  const output = await run(
    [
      "reminder",
      "schedule",
      "--title",
      "Daily standup",
      "--target",
      "#general",
      "--message-id",
      "deadbeef",
      "--fire-at",
      "2026-09-09T09:30:00+08:00",
      "--repeat",
      "weekly:mon,fri@09:30",
      "--tz",
      "Asia/Shanghai",
    ],
    {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => undefined,
      view: async () => ({ bytes: new Uint8Array() }),
      reminder: async (request) => {
        calls.push(request);
        return {
          protocolMajor: 1,
          requestId: "request",
          workspaceId: "workspace",
          computerId: "computer",
          agentId: "agent",
          accepted: true,
          reminders: [],
          events: [],
        };
      },
    },
  );
  expect(calls).toEqual([
    {
      operation: "schedule",
      title: "Daily standup",
      target: "#general",
      messageId: "deadbeef",
      fireAt: "2026-09-09T09:30:00+08:00",
      repeat: "weekly:mon,fri@09:30",
      timezone: "Asia/Shanghai",
    },
  ]);
  expect(output).toBe("Accepted reminder schedule request.");
});

test("rejects malformed and ambiguous reminder commands", () => {
  expect(() => parseArgs(["reminder", "cancel", "--id", "12345678"])).toThrow("full UUID");
  expect(() => parseArgs(["reminder", "list", "--all", "--status", "scheduled"])).toThrow("Usage:");
  expect(() =>
    parseArgs([
      "reminder",
      "snooze",
      "--id",
      reminderId,
      "--delay-seconds",
      "2",
      "--fire-at",
      "2026-09-09T00:00:00Z",
    ]),
  ).toThrow("Usage:");
  expect(() => parseArgs(["reminder", "schedule", "--title", "a", "--title", "b"])).toThrow(
    "Duplicate",
  );
  expect(() => parseArgs(["reminder", "log", "--wat", "x"])).toThrow("Unknown");
});

test("formats usable reminder lists, empty logs, and receipt acknowledgements", async () => {
  const base = {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
  };
  const output = await run(["reminder", "list", "--all"], {
    ...base,
    reminder: async () => ({
      protocolMajor: 1,
      requestId: "request",
      workspaceId: "workspace",
      computerId: "computer",
      agentId: "agent",
      accepted: true,
      events: [],
      reminders: [
        {
          reminderId,
          ownerAgentId: "agent",
          version: 3,
          title: "Deploy",
          target: "#release",
          messageId: "deadbeef",
          fireAt: "2026-09-09T01:00:00Z",
          status: "scheduled",
          repeat: "every:1d",
          timezone: "Asia/Shanghai",
          createdAt: "2026-09-08T01:00:00Z",
        },
      ],
    }),
  });
  expect(output).toContain(`id=${reminderId} revision=3 status=scheduled`);
  expect(output).toContain("anchor=deadbeef target=#release");
  expect(
    await run(["reminder", "log", "--id", reminderId], {
      ...base,
      reminder: async () => ({
        protocolMajor: 1,
        requestId: "request",
        workspaceId: "workspace",
        computerId: "computer",
        agentId: "agent",
        accepted: true,
        reminders: [],
        events: [],
      }),
    }),
  ).toBe("No reminder events found.");
  expect(
    await run(["reminder", "ack", "--id", reminderId, "--revision", "3"], {
      ...base,
      reminder: async () => ({ accepted: true, reminderId, revision: 3 }),
    }),
  ).toContain(`id=${reminderId} revision=3`);
});

test("Task commands require exact arguments and reject thread targets", () => {
  expect(
    parseArgs(["task", "claim", "--target", "#general", "--message-id", "message-1"]),
  ).toMatchObject({
    command: "task",
    task: { operation: "claim", target: "#general", messageId: "message-1" },
  });
  expect(parseArgs(["task", "list", "--target", "@ada", "--status", "todo"])).toMatchObject({
    command: "task",
    task: { operation: "list", target: "@ada", status: "todo" },
  });
  expect(() => parseArgs(["task", "claim", "--target", "#general"])).toThrow("Usage:");
  expect(() => parseArgs(["task", "list", "--target", "#general:deadbeef"])).toThrow("Usage:");
  expect(() => parseArgs(["task", "delete", "--target", "#general"])).toThrow("Usage:");
});

test("Task update reads one revision then submits once and formats Thread-useful identity", async () => {
  const calls: any[] = [];
  const output = await run(
    ["task", "update", "--target", "#general", "--number", "2", "--status", "in_review"],
    {
      check: async () => ({ messages: [] }),
      read: async () => ({}),
      send: async () => ({}),
      view: async () => ({ bytes: new Uint8Array() }),
      task: async (command) => {
        calls.push(command);
        return {
          tasks: [
            {
              messageId: "message-2",
              conversationId: "conversation",
              number: 2,
              title: "Verify",
              status: command.operation === "update" ? "in_review" : "in_progress",
              revision: 5,
              owner: { memberId: "member", kind: "agent", name: "builder" },
            },
          ],
        };
      },
    },
  );
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({ operation: "update", expectedRevision: 5 });
  expect(output).toContain("#2 status=in_review owner=builder message=message-2");
});

test("Task unclaim reads one revision unless explicitly supplied and submits once", async () => {
  for (const args of [
    ["task", "unclaim", "--target", "#general", "--number", "2"],
    ["task", "unclaim", "--target", "#general", "--number", "2", "--expected-revision", "4"],
  ]) {
    const calls: any[] = [];
    await run(args, {
      check: async () => ({ messages: [] }),
      read: async () => ({}),
      send: async () => ({}),
      view: async () => ({ bytes: new Uint8Array() }),
      task: async (command) => {
        calls.push(command);
        return {
          tasks: [
            {
              messageId: "message-2",
              conversationId: "conversation",
              number: 2,
              title: "Verify",
              status: "in_progress",
              revision: 4,
              owner: { memberId: "member", kind: "agent", name: "builder" },
            },
          ],
        };
      },
    });
    expect(calls.at(-1)).toMatchObject({ operation: "unclaim", expectedRevision: 4 });
    expect(calls).toHaveLength(args.includes("--expected-revision") ? 1 : 2);
  }
});

test("Agent channel mute and unmute change its own setting without sending a message", async () => {
  const calls: unknown[] = [];
  for (const command of ["mute", "unmute"] as const) {
    expect(parseArgs(["channel", command, "--target", "#general"])).toEqual({
      command,
      target: "#general",
    });
    await run(["channel", command, "--target", "#general"], {
      check: async () => {
        throw new Error("unexpected check");
      },
      read: async () => {
        throw new Error("unexpected read");
      },
      send: async () => {
        throw new Error("unexpected send");
      },
      view: async () => {
        throw new Error("unexpected view");
      },
      setChannelMuted: async (target, muted) => {
        calls.push([target, muted]);
        return { accepted: true };
      },
    });
  }
  expect(calls).toEqual([
    ["#general", true],
    ["#general", false],
  ]);
  expect(() => parseArgs(["channel", "mute", "--target", "@alice"])).toThrow("Usage:");
  expect(() => parseArgs(["channel", "mute", "--target", "#general:12345678"])).toThrow("Usage:");
});

test("Agent thread unfollow changes only the exact channel thread", async () => {
  const calls: unknown[] = [];
  expect(parseArgs(["thread", "unfollow", "--target", "#general:12345678"])).toEqual({
    command: "thread-unfollow",
    target: "#general:12345678",
  });
  await run(["thread", "unfollow", "--target", "#general:12345678"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
    setThreadFollowed: async (target, followed) => {
      calls.push([target, followed]);
      return { accepted: true };
    },
  });
  expect(calls).toEqual([["#general:12345678", false]]);
  expect(() => parseArgs(["thread", "unfollow", "--target", "#general"])).toThrow("Usage:");
  expect(() => parseArgs(["thread", "unfollow", "--target", "@alice:12345678"])).toThrow("Usage:");
});

test("message check has no target arguments", () => {
  expect(parseArgs(["message", "check"])).toEqual({ command: "check" });
  expect(() => parseArgs(["message", "check", "--target", "@ada"])).toThrow("Usage:");
});

test("message search aligns with Raft lexical search options and dispatches them", async () => {
  expect(
    parseArgs([
      "message",
      "search",
      "--query",
      "release plan",
      "--target",
      "#general",
      "--sender",
      "@ada",
      "--sort",
      "recent",
      "--before",
      "2026-09-07T12:00:00Z",
      "--limit",
      "10",
      "--offset",
      "2",
    ]),
  ).toEqual({
    command: "search",
    query: "release plan",
    target: "#general",
    sender: "@ada",
    sort: "recent",
    before: "2026-09-07T12:00:00Z",
    limit: 10,
    offset: 2,
  });
  const calls: unknown[] = [];
  const output = await run(["message", "search", "--query", "release", "--limit", "5"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    search: async (options) => {
      calls.push(options);
      return {
        messages: [
          {
            id: "aaaaaaaa-0000-4000-8000-000000000001",
            sequence: 99,
            sender: "@ada",
            target: "#general",
            body: "release plan",
            createdAt: "2026-09-07T10:00:00Z",
          },
        ],
      };
    },
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
  });
  expect(calls).toEqual([{ query: "release", limit: 5 }]);
  expect(output).toContain('"id":"aaaaaaaa-0000-4000-8000-000000000001"');
  expect(output).toContain('"target":"#general"');
  expect(output).not.toContain("sequence");
});

test("message search rejects empty searches and invalid Raft options", () => {
  expect(() => parseArgs(["message", "search"])).toThrow("Usage:");
  expect(() => parseArgs(["message", "search", "--query", "x", "--sort", "oldest"])).toThrow(
    "Usage:",
  );
  expect(() => parseArgs(["message", "search", "--query", "x", "--offset", "-1"])).toThrow(
    "Usage:",
  );
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
    "[target=@ada msg=message- time=2026-09-03T10:00:00Z] @ada: Can you investigate?\n\nNo more new inbox messages.",
  );
});

test("thread target and short parent range anchor pass through without a separate root option", async () => {
  const calls: unknown[] = [];
  const transport = {
    check: async () => ({ messages: [] }),
    read: async (target: string, options: unknown) => {
      calls.push({ target, options });
      return {};
    },
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
  };
  await run(
    ["message", "read", "--target", "@alice:12345678", "--before", "87654321", "--limit", "10"],
    transport,
  );
  expect(calls[0]).toMatchObject({
    target: "@alice:12345678",
    options: { before: "87654321", limit: 10 },
  });
  expect(() =>
    parseArgs(["message", "read", "--target", "@alice", "--root", "12345678"]),
  ).toThrow();
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

test("held sends fail with draft retry instructions", async () => {
  await expect(
    run(["message", "send", "--target", "@ada"], {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => ({
        accepted: false,
        sideEffectDecision: "hold",
        messages: [{ id: "message-2", sequence: 9, body: "new context" }],
      }),
      view: async () => ({ bytes: new Uint8Array() }),
    }),
  ).rejects.toThrow("saved as a draft");
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
