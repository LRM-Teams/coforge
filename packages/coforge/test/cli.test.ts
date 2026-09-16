import { expect, test } from "bun:test";
import { parseArgs, run } from "../index";
import { validateTaskRequest } from "@lrm/coforge-sdk/internal";
import {
  createAgentApiClient,
  createAgentApiRawClient,
  createAgentApiSurfaceClient,
  workspaceInfoRoute,
} from "@lrm/coforge-sdk/agent";

test("Agent API client requests workspace info through its route contract", async () => {
  const calls: unknown[] = [];
  const client = createAgentApiClient({
    request: async (route) => {
      calls.push(route);
      return {
        ok: true,
        status: 200,
        data: {
          protocolMajor: 1,
          requestId: "r",
          workspace: { id: "w", name: "Acme", slug: "acme" },
          humans: [],
          agents: [],
          projects: [],
        },
      };
    },
  });

  await expect(client.workspace.info()).resolves.toMatchObject({ workspace: { slug: "acme" } });
  expect(calls).toEqual([workspaceInfoRoute]);
});

test("Agent API raw and surface clients preserve Raft-style error layering", async () => {
  const transport = {
    request: async () => ({ ok: false as const, status: 403, error: "workspace access denied" }),
  };
  await expect(createAgentApiRawClient(transport).workspace.info()).resolves.toEqual({
    ok: false,
    status: 403,
    error: "workspace access denied",
  });
  await expect(createAgentApiSurfaceClient(transport).workspace.info()).rejects.toThrow(
    "workspace access denied",
  );
});

test("workspace info parses validated sections and formats a mocked summary", async () => {
  expect(
    parseArgs([
      "workspace",
      "info",
      "--projects",
      "--query",
      "core",
      "--limit",
      "1",
      "--offset",
      "0",
    ]),
  ).toEqual({
    command: "workspace.info",
    projects: true,
    query: "core",
    limit: 1,
    offset: 0,
  });
  const output = await run(["workspace", "info", "--projects", "--query", "core"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
    workspaceInfo: async () => ({
      protocolMajor: 1,
      requestId: "r",
      workspace: { id: "w", name: "Acme", slug: "acme" },
      humans: [],
      agents: [],
      projects: [
        { id: "p", name: "Core", slug: "core", githubFullName: "acme/core", githubHtmlUrl: "" },
      ],
    }),
  });
  expect(output).toBe("Core (core) github=acme/core");
});

test("workspace info rejects invalid pagination and conflicting sections", () => {
  expect(() => parseArgs(["workspace", "info", "--limit", "0"])).toThrow("Usage:");
  expect(() => parseArgs(["workspace", "info", "--offset", "-1"])).toThrow("Usage:");
  expect(() => parseArgs(["workspace", "info", "--full", "--agents"])).toThrow("Usage:");
});

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
  expect(
    parseArgs([
      "task",
      "create",
      "--target",
      "#general",
      "--title",
      "Ship it",
      "--assignee",
      "@ada",
    ]),
  ).toMatchObject({ task: { operation: "create", title: "Ship it", assignee: "@ada" } });
  expect(() => parseArgs(["task", "claim", "--target", "#general"])).toThrow("Usage:");
  expect(() => parseArgs(["task", "list", "--target", "#general:deadbeef"])).toThrow("Usage:");
  expect(() => parseArgs(["task", "delete", "--target", "#general"])).toThrow("Usage:");
});

test("Task command parsing covers Raft lifecycle actions and explicit description clearing", () => {
  expect(
    parseArgs(["task", "assign", "--target", "#general", "--number", "2", "--assignee", "@ada"]),
  ).toMatchObject({ task: { operation: "assign", number: 2, assignee: "@ada" } });
  expect(
    parseArgs(["task", "amend", "--target", "#general", "--number", "2", "--clear-description"]),
  ).toMatchObject({ task: { operation: "amend", number: 2, description: null } });
  for (const operation of ["history", "delete"] as const)
    expect(parseArgs(["task", operation, "--target", "#general", "--number", "2"])).toMatchObject({
      task: { operation, number: 2 },
    });
});

test("Task receipt forwards all seven fields through the backend contract", async () => {
  const receipt = {
    object: "bucket preview-719",
    purpose: "Review build artifacts",
    teardownOwner: "@ada",
    securityPrivacy: "Private; no credentials stored",
    expiry: "2030-03-04T05:06:00.000Z",
    runbook: "docs/cleanup.md",
    tracking: "#general:12345678",
  };
  const flags = [
    "--object",
    "--purpose",
    "--teardown-owner",
    "--security-privacy",
    "--expiry",
    "--runbook",
    "--tracking",
  ];
  const values = [
    receipt.object,
    receipt.purpose,
    receipt.teardownOwner,
    receipt.securityPrivacy,
    "2030-03-04T13:06:00+08:00",
    receipt.runbook,
    receipt.tracking,
  ];
  const base = ["task", "receipt", "--target", "#general", "--number", "7"];
  const calls: unknown[] = [];
  await run([...base, ...flags.flatMap((flag, index) => [flag, ` ${values[index]} `])], {
    check: async () => ({ messages: [] }),
    read: async () => ({}),
    send: async () => ({}),
    view: async () => ({ bytes: new Uint8Array() }),
    task: async (command) => {
      validateTaskRequest({
        ...command,
        protocolMajor: 1,
        workspaceId: "workspace",
        agentId: "agent",
      });
      calls.push(command);
      return { tasks: [] };
    },
  });
  expect(calls).toEqual([expect.objectContaining({ operation: "receipt", number: 7, receipt })]);
  for (const omitted of flags)
    expect(() =>
      parseArgs([
        ...base,
        ...flags.flatMap((flag, index) => (flag === omitted ? [] : [flag, values[index]!])),
      ]),
    ).toThrow();
});

test("Task amendment rejects conflicting description options before dispatch", async () => {
  for (const options of [
    ["--description", "Keep deployment instructions", "--clear-description"],
    ["--clear-description", "--description", "Keep deployment instructions"],
  ]) {
    const calls: unknown[] = [];
    await expect(
      run(["task", "amend", "--target", "#general", "--number", "7", ...options], {
        check: async () => ({ messages: [] }),
        read: async () => ({}),
        send: async () => ({}),
        view: async () => ({ bytes: new Uint8Array() }),
        task: async (command) => {
          calls.push(command);
          return { tasks: [] };
        },
      }),
    ).rejects.toThrow("Use either --description or --clear-description, not both");
    expect(calls).toEqual([]);
  }
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

test("message resolve looks up one message by id and formats it like message check", async () => {
  expect(parseArgs(["message", "resolve", "abcd1234"])).toEqual({
    command: "resolve",
    messageId: "abcd1234",
  });
  const calls: string[] = [];
  const output = await run(["message", "resolve", "abcd1234"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
    resolve: async (messageId) => {
      calls.push(messageId);
      return {
        messages: [
          {
            id: "abcd1234-0000-4000-8000-000000000001",
            sequence: 1,
            sender: "@ada",
            target: "#general",
            body: "release plan",
            createdAt: "2026-09-07T10:00:00Z",
          },
        ],
      };
    },
  });
  expect(calls).toEqual(["abcd1234"]);
  expect(output).toBe(
    "[target=#general msg=abcd1234 time=2026-09-07T10:00:00Z] @ada: release plan",
  );
});

test("message resolve reports a clear error when the message is not found", async () => {
  await expect(
    run(["message", "resolve", "abcd1234"], {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => undefined,
      view: async () => ({ bytes: new Uint8Array() }),
      resolve: async () => ({ messages: [] }),
    }),
  ).rejects.toThrow("message not found or not visible to this Agent");
});

test("message resolve rejects malformed argument shapes", () => {
  expect(() => parseArgs(["message", "resolve"])).toThrow("Usage:");
  expect(() => parseArgs(["message", "resolve", "abcd1234", "extra"])).toThrow("Usage:");
});

test.each([
  [false, "added to"],
  [true, "removed from"],
] as const)(
  "message react parses flags in any order and dispatches with remove=%s",
  async (remove, verb) => {
    const flags = remove
      ? ["--emoji", "👍", "--remove", "--message-id", "abcd1234"]
      : ["--message-id", "abcd1234", "--emoji", "👍"];
    expect(parseArgs(["message", "react", ...flags])).toEqual({
      command: "react",
      messageId: "abcd1234",
      emoji: "👍",
      ...(remove ? { remove: true } : {}),
    });
    const calls: unknown[] = [];
    const output = await run(["message", "react", ...flags], {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => undefined,
      view: async () => ({ bytes: new Uint8Array() }),
      react: async (messageId, emoji, removeArg) => {
        calls.push([messageId, emoji, removeArg === true]);
        return { accepted: true };
      },
    });
    expect(calls).toEqual([["abcd1234", "👍", remove]]);
    expect(output).toBe(`Reaction 👍 ${verb} message abcd1234.`);
  },
);

test("message react rejects bad ids, missing emoji, whitespace emoji, and --remove without --emoji", () => {
  // bad id
  expect(() => parseArgs(["message", "react", "--message-id", "not-hex", "--emoji", "👍"])).toThrow(
    "Usage:",
  );
  // missing emoji
  expect(() => parseArgs(["message", "react", "--message-id", "abcd1234"])).toThrow("Usage:");
  // whitespace emoji
  expect(() =>
    parseArgs(["message", "react", "--message-id", "abcd1234", "--emoji", "a b"]),
  ).toThrow("Usage:");
  // --remove without --emoji
  expect(() => parseArgs(["message", "react", "--message-id", "abcd1234", "--remove"])).toThrow(
    "Usage:",
  );
});

test("message resolve rejects an emoji-shaped or malformed id", () => {
  expect(() => parseArgs(["message", "resolve", "not-hex"])).toThrow("Usage:");
  expect(() => parseArgs(["message", "resolve", "abcd123"])).toThrow("Usage:");
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
  expect(
    parseArgs(["attachment", "view", "--id", "attachment-1", "--output", "/tmp/file.txt"]),
  ).toEqual({
    command: "attachment.view",
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
    "[target=@ada msg=message- time=2026-09-03T10:00:00Z] @ada: Can you investigate?\n\nNo more new messages.",
  );
});

test("message check tells the Agent to run check again when the server reports more remain", async () => {
  const output = await run(["message", "check"], {
    check: async () => ({
      accepted: true,
      hasMore: true,
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
    "[target=@ada msg=message- time=2026-09-03T10:00:00Z] @ada: Can you investigate?\n\nMore messages are pending. Run `coforge message check` again.",
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

  expect(output).toBe("No new messages.");
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

test("--reviewer-isolation is accepted only on send, claim, update and amend", () => {
  expect(parseArgs(["message", "send", "--target", "@ada", "--reviewer-isolation"])).toMatchObject({
    command: "send",
    freshnessContextMode: "withheld",
  });
  expect(
    parseArgs(["task", "claim", "--target", "#general", "--number", "1", "--reviewer-isolation"]),
  ).toMatchObject({ task: { operation: "claim", freshnessContextMode: "withheld" } });
  expect(
    parseArgs([
      "task",
      "update",
      "--target",
      "#general",
      "--number",
      "1",
      "--status",
      "in_review",
      "--expected-revision",
      "5",
      "--reviewer-isolation",
    ]),
  ).toMatchObject({ task: { operation: "update", freshnessContextMode: "withheld" } });
  expect(
    parseArgs([
      "task",
      "amend",
      "--target",
      "#general",
      "--number",
      "1",
      "--title",
      "Ship it",
      "--reviewer-isolation",
    ]),
  ).toMatchObject({ task: { operation: "amend", freshnessContextMode: "withheld" } });
  expect(() => parseArgs(["task", "list", "--target", "#general", "--reviewer-isolation"])).toThrow(
    "Usage:",
  );
  expect(() =>
    parseArgs(["task", "unclaim", "--target", "#general", "--number", "1", "--reviewer-isolation"]),
  ).toThrow("Usage:");
  expect(() => parseArgs(["message", "read", "--target", "@ada", "--reviewer-isolation"])).toThrow(
    "Usage:",
  );
});

test("COFORGE_REVIEWER_ISOLATION environment variable enables reviewer isolation without the flag", () => {
  const previous = process.env.COFORGE_REVIEWER_ISOLATION;
  try {
    process.env.COFORGE_REVIEWER_ISOLATION = "1";
    expect(parseArgs(["message", "send", "--target", "@ada"])).toMatchObject({
      freshnessContextMode: "withheld",
    });
    expect(parseArgs(["task", "claim", "--target", "#general", "--number", "1"])).toMatchObject({
      task: { freshnessContextMode: "withheld" },
    });
    process.env.COFORGE_REVIEWER_ISOLATION = "not-a-boolean";
    expect(() => parseArgs(["message", "send", "--target", "@ada"])).toThrow(
      "COFORGE_REVIEWER_ISOLATION must be one of: 1, true, 0, false",
    );
  } finally {
    if (previous === undefined) delete process.env.COFORGE_REVIEWER_ISOLATION;
    else process.env.COFORGE_REVIEWER_ISOLATION = previous;
  }
});

test("reviewer-isolation held Task output suppresses secret context", async () => {
  const output = await run(
    ["task", "claim", "--target", "#general", "--number", "1", "--reviewer-isolation"],
    {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => undefined,
      view: async () => ({ bytes: new Uint8Array() }),
      task: async () => ({
        tasks: [],
        state: "held",
        freshnessContextMode: "withheld",
        newMessageCount: 2,
        heldMessages: [
          {
            id: "secret-id",
            sequence: 1,
            sender: "secret-sender",
            target: "#secret",
            body: "SECRET_SENTINEL",
            createdAt: "now",
          },
        ],
      }),
    },
  );
  expect(output).toBe("Reviewer-isolation freshness hold: 2 newer messages withheld.");
  expect(output).not.toContain("SECRET_SENTINEL");
});

test("requested reviewer isolation suppresses held Task context even when the response says inline", async () => {
  const output = await run(
    [
      "task",
      "update",
      "--target",
      "#general",
      "--number",
      "1",
      "--status",
      "in_review",
      "--expected-revision",
      "5",
      "--reviewer-isolation",
    ],
    {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => undefined,
      view: async () => ({ bytes: new Uint8Array() }),
      task: async () => ({
        tasks: [],
        state: "held",
        freshnessContextMode: "inline",
        newMessageCount: 1,
        heldMessages: [
          {
            id: "secret-id",
            sequence: 1,
            sender: "secret-sender",
            target: "#secret",
            body: "SECRET_SENTINEL",
            createdAt: "now",
          },
        ],
      }),
    },
  );
  expect(output).toBe("Reviewer-isolation freshness hold: 1 newer message withheld.");
  expect(output).not.toContain("SECRET_SENTINEL");
});

test("non-reviewer-isolation Task holds still surface the held messages", async () => {
  const output = await run(
    [
      "task",
      "update",
      "--target",
      "#general",
      "--number",
      "1",
      "--status",
      "in_review",
      "--expected-revision",
      "5",
    ],
    {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => undefined,
      view: async () => ({ bytes: new Uint8Array() }),
      task: async () => ({
        tasks: [],
        state: "held",
        heldMessages: [
          {
            id: "visible-id",
            sequence: 1,
            sender: "@ada",
            target: "#general",
            body: "VISIBLE_CONTEXT",
            createdAt: "now",
          },
        ],
      }),
    },
  );
  expect(output).toContain("Task request held.");
  expect(output).toContain("VISIBLE_CONTEXT");
});

test("reviewer-isolation Task transport failures redact upstream detail", async () => {
  await expect(
    run(
      [
        "task",
        "update",
        "--target",
        "#general",
        "--number",
        "1",
        "--status",
        "in_review",
        "--expected-revision",
        "5",
        "--reviewer-isolation",
      ],
      {
        check: async () => ({ messages: [] }),
        read: async () => undefined,
        send: async () => undefined,
        view: async () => ({ bytes: new Uint8Array() }),
        task: async () => {
          throw new Error("SECRET_UPSTREAM_DETAIL");
        },
      },
    ),
  ).rejects.toThrow("Reviewer-isolation Task request failed; upstream detail was withheld");
});

test("reviewer-isolation send redacts transport failures and held context", async () => {
  await expect(
    run(["message", "send", "--target", "@ada", "--send-draft", "--reviewer-isolation"], {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => {
        throw new Error("SECRET_UPSTREAM_DETAIL");
      },
      view: async () => ({ bytes: new Uint8Array() }),
    }),
  ).rejects.toThrow("Reviewer-isolation send failed; upstream response detail was withheld.");

  await expect(
    run(["message", "send", "--target", "@ada", "--send-draft", "--reviewer-isolation"], {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => ({
        accepted: false,
        sideEffectDecision: "hold",
        freshnessContextMode: "inline",
        newMessageCount: 2,
        messages: [{ body: "SECRET_HELD_DETAIL" }],
      }),
      view: async () => ({ bytes: new Uint8Array() }),
    }),
  ).rejects.toThrow("Reviewer-isolation freshness hold: 2 newer messages withheld.");
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

test("weekly-report CLI parses bounded reads and dispatches the transport", async () => {
  const invocation = parseArgs([
    "weekly-report",
    "read",
    "--report-id",
    "33333333-3333-4333-8333-333333333333",
    "--section",
    "Progress",
    "--max-characters",
    "120",
  ]);
  expect(invocation).toEqual({
    command: "weekly-report",
    weeklyReport: {
      operation: "read",
      reportId: "33333333-3333-4333-8333-333333333333",
      section: "Progress",
      maxCharacters: 120,
    },
  });
  const calls: unknown[] = [];
  const output = await run(["weekly-report", "list", "--limit", "2"], {
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
    weeklyReport: async (command) => {
      calls.push(command);
      return {
        protocolMajor: 1,
        requestId: "request",
        operation: "list",
        result: { reports: [], nextCursor: null },
      };
    },
  });
  expect(calls).toEqual([{ operation: "list", limit: 2 }]);
  expect(output).toEqual({
    protocolMajor: 1,
    requestId: "request",
    operation: "list",
    result: { reports: [], nextCursor: null },
  });
});

test("weekly-report CLI rejects oversized list limits", () => {
  expect(() => parseArgs(["weekly-report", "list", "--limit", "51"])).toThrow("Usage:");
});
