import { describe, expect, test } from "bun:test";

import {
  groupSystemMessages,
  summarizeSystemGroup,
  systemMessageKind,
} from "./system-message-groups";

type Row = { id: string; senderKind: "user" | "agent" | "system"; body: string };

const system = (id: string, body = `notice ${id}`): Row => ({ id, senderKind: "system", body });
const user = (id: string): Row => ({ id, senderKind: "user", body: `hello ${id}` });

describe("system message kind", () => {
  test("task notices in the current wording are task updates", () => {
    expect(systemMessageKind("@frank-an started task #4.")).toBe("taskUpdate");
    expect(systemMessageKind("@coder was assigned tasks #3, #4.")).toBe("taskUpdate");
  });

  test("task notices in the emoji-led wording are task updates", () => {
    expect(systemMessageKind('📌 frank-an claimed #4 "Fix login"')).toBe("taskUpdate");
    expect(systemMessageKind('🔄 Frank An moved #4 "Fix login" to In Progress')).toBe("taskUpdate");
    expect(systemMessageKind('📋 1 new task created: #4 "Fix login"')).toBe("taskUpdate");
    expect(systemMessageKind("📋 3 new tasks created: #4, #5, #6")).toBe("taskUpdate");
    expect(systemMessageKind('🔓 frank-an released #4 "Fix login"')).toBe("taskUpdate");
    expect(systemMessageKind("🗑️ frank-an deleted #4")).toBe("taskUpdate");
    expect(systemMessageKind("frank-an converted a message to task #7")).toBe("taskUpdate");
  });

  test("an assignment or unassignment notice is summarized as a system message, as in Raft", () => {
    expect(systemMessageKind('📌 Assigned @coder to task #3 "Fix login"')).toBe("system");
    expect(systemMessageKind('🔓 Frank An unassigned #4 "Fix login"')).toBe("system");
  });

  test("reminder notices are reminder updates, with or without a leading emoji", () => {
    expect(systemMessageKind("⏰ Reminder: stand-up in five minutes")).toBe("reminder");
    expect(systemMessageKind("Reminder (daily): water the plants")).toBe("reminder");
    expect(systemMessageKind("Reminder #r12 fired")).toBe("reminder");
    expect(systemMessageKind("@coder scheduled a reminder for 9:00")).toBe("reminder");
    expect(systemMessageKind("Frank An cancelled reminder #r12")).toBe("reminder");
  });

  test("anything else is a plain system message", () => {
    expect(systemMessageKind("@frank-an joined the channel.")).toBe("system");
    expect(systemMessageKind("👋 Welcome to #general")).toBe("system");
    expect(systemMessageKind("")).toBe("system");
  });
});

describe("grouping system messages", () => {
  test("a run of two or more consecutive system messages becomes one group", () => {
    const items = groupSystemMessages([user("u1"), system("a"), system("b"), system("c")]);

    expect(items).toEqual([
      { type: "message", message: user("u1") },
      {
        type: "systemGroup",
        id: "system-group:a:c",
        messages: [system("a"), system("b"), system("c")],
      },
    ]);
  });

  test("a single system message stays a message", () => {
    const items = groupSystemMessages([system("a"), user("u1"), system("b")]);

    expect(items.map((item) => item.type)).toEqual(["message", "message", "message"]);
  });

  test("a non-system message ends the run", () => {
    const items = groupSystemMessages([
      system("a"),
      system("b"),
      user("u1"),
      system("c"),
      system("d"),
    ]);

    expect(items.map((item) => (item.type === "systemGroup" ? item.id : item.message.id))).toEqual([
      "system-group:a:b",
      "u1",
      "system-group:c:d",
    ]);
  });

  test("a break the caller asks for splits a run, and a lone leftover stays a message", () => {
    const items = groupSystemMessages(
      [system("a"), system("b"), system("c")],
      (message) => message.id === "c",
    );

    expect(items.map((item) => (item.type === "systemGroup" ? item.id : item.message.id))).toEqual([
      "system-group:a:b",
      "c",
    ]);
  });
});

describe("summarizing a group", () => {
  test("counts each kind and lists task updates, reminders, then other system messages", () => {
    const summary = summarizeSystemGroup([
      system("a", "Frank An joined the channel."),
      system("b", '📌 frank-an claimed #4 "Fix login"'),
      system("c", "⏰ Reminder: stand-up"),
      system("d", '🔄 Frank An moved #4 "Fix login" to Done'),
    ]);

    expect(summary).toEqual({
      total: 4,
      parts: [
        { kind: "taskUpdate", count: 2 },
        { kind: "reminder", count: 1 },
        { kind: "system", count: 1 },
      ],
    });
  });

  test("leaves out the kinds a group does not contain", () => {
    const summary = summarizeSystemGroup([
      system("a", "@coder started task #1."),
      system("b", "@coder started task #2."),
    ]);

    expect(summary).toEqual({ total: 2, parts: [{ kind: "taskUpdate", count: 2 }] });
  });
});
