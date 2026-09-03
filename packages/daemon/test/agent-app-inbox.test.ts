import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { AgentAppInbox } from "../src/agent-app-inbox/agent-app-inbox";

const roots: string[] = [];
const reminderId = "123e4567-e89b-42d3-a456-426614174000";
const due = (revision = "1") => ({
  appId: "system.reminder",
  notificationClass: "due",
  sourceRef: { kind: "reminder", id: reminderId, revision },
  title: "Review release",
  summary: "Reminder is due",
});
function root() {
  const value = join(tmpdir(), `coforge-app-inbox-${crypto.randomUUID()}`);
  roots.push(value);
  return value;
}
afterEach(() =>
  Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe("AgentAppInbox", () => {
  test("rejects unknown registry entries, invalid source refs, and unsafe previews", async () => {
    const inbox = await AgentAppInbox.open(root(), "workspace-a", "agent-a");
    await expect(inbox.upsert({ ...due(), appId: "unknown" })).rejects.toThrow(
      "unknown App Inbox app",
    );
    await expect(inbox.upsert({ ...due(), notificationClass: "unknown" })).rejects.toThrow(
      "unknown App Inbox class",
    );
    await expect(
      inbox.upsert({ ...due(), sourceRef: { kind: "reminder", id: "../bad", revision: "1" } }),
    ).rejects.toThrow("UUID");
    await expect(inbox.upsert({ ...due(), title: "line one\nline two" })).rejects.toThrow(
      "single-line",
    );
    await expect(inbox.upsert({ ...due(), summary: "x".repeat(121) })).rejects.toThrow(
      "single-line",
    );
  });

  test("omits empty optional previews", async () => {
    const inbox = await AgentAppInbox.open(root(), "workspace-a", "agent-a");
    const { title: _title, summary: _summary, ...withoutPreviews } = due();
    const item = await inbox.upsert({ ...withoutPreviews, title: "" });

    expect(item).not.toHaveProperty("title");
    expect(item).not.toHaveProperty("summary");
  });

  test("upserts stable identity while isolating reminder revisions and derives its action", async () => {
    const inbox = await AgentAppInbox.open(root(), "workspace-a", "agent-a");
    const first = await inbox.upsert(due());
    const updated = await inbox.upsert({ ...due(), summary: "Updated" });
    await inbox.upsert(due("2"));
    expect(updated.itemId).toBe(first.itemId);
    expect(inbox.list()).toHaveLength(2);
    expect(
      inbox
        .list()
        .map((item) => item.itemId)
        .sort(),
    ).toEqual([`reminder:${reminderId}:1`, `reminder:${reminderId}:2`]);
    expect(updated).toMatchObject({
      retention: "until_explicit_ack",
      action: { kind: "run_command", commandId: "reminder.ack" },
    });
    expect(updated).not.toHaveProperty("messageId");
    expect(updated).not.toHaveProperty("argv");
  });

  test("restores durable items after restart without a generic acknowledgement", async () => {
    const directory = root();
    const inbox = await AgentAppInbox.open(directory, "workspace-a", "agent-a");
    const item = await inbox.upsert(due());
    const restored = await AgentAppInbox.open(directory, "workspace-a", "agent-a");
    expect(restored.list()).toEqual([item]);
    expect(restored.list()).toEqual([item]);
  });

  test("fails explicitly for corrupt persistence and unsafe path scopes", async () => {
    const directory = root();
    const path = join(directory, "app-inbox", "workspace-a", "agent-a", "items.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "not-json");
    await expect(AgentAppInbox.open(directory, "workspace-a", "agent-a")).rejects.toThrow(
      "corrupt",
    );
    await expect(AgentAppInbox.open(directory, "../workspace", "agent-a")).rejects.toThrow(
      "path scope",
    );
  });
});
