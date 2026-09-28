import { describe, expect, test } from "bun:test";

import { WorkspacePresence } from "#src/features/workspaces/member-presence";

const client = (id: string, user: string) => ({ client: id, user });

describe("WorkspacePresence", () => {
  test("knows nobody's presence until the first presence read", () => {
    const presence = new WorkspacePresence();
    expect(presence.isOnline("ada")).toBeUndefined();
    presence.beginRead()({ c1: client("c1", "ada") });
    expect(presence.isOnline("ada")).toBe(true);
    expect(presence.isOnline("grace")).toBe(false);
  });

  test("a person with several tabs goes offline only when the last one leaves", () => {
    const presence = new WorkspacePresence();
    presence.beginRead()({});
    presence.join(client("tab-1", "ada"));
    presence.join(client("tab-2", "ada"));
    presence.leave(client("tab-1", "ada"));
    expect(presence.isOnline("ada")).toBe(true);
    presence.leave(client("tab-2", "ada"));
    expect(presence.isOnline("ada")).toBe(false);
  });

  test("a fresh presence read replaces what join and leave built up", () => {
    const presence = new WorkspacePresence();
    presence.beginRead()({});
    presence.join(client("tab-1", "ada"));
    // A leave missed while disconnected: the read after resubscribing is the truth.
    presence.beginRead()({ "tab-9": client("tab-9", "grace") });
    expect(presence.isOnline("ada")).toBe(false);
    expect(presence.isOnline("grace")).toBe(true);
  });

  test("tells listeners once presence is known and on every change after", () => {
    const presence = new WorkspacePresence();
    let notified = 0;
    presence.subscribe(() => notified++);
    presence.join(client("c1", "ada"));
    expect(notified).toBe(0);
    presence.beginRead()({ c1: client("c1", "ada") });
    presence.leave(client("c1", "ada"));
    expect(notified).toBe(2);
  });

  test("joins and leaves before the first read are kept", () => {
    const presence = new WorkspacePresence();
    presence.join(client("c1", "ada"));
    expect(presence.isOnline("ada")).toBeUndefined();
    presence.beginRead()({ c1: client("c1", "ada"), c2: client("c2", "grace") });
    expect(presence.isOnline("grace")).toBe(true);
  });

  test("joins and leaves that arrive while a read is in flight are applied on top of it", () => {
    const presence = new WorkspacePresence();
    const finish = presence.beginRead();
    // The server took its snapshot (ada only), then grace opened a tab and ada closed hers.
    presence.join(client("c2", "grace"));
    presence.leave(client("c1", "ada"));
    finish({ c1: client("c1", "ada") });
    expect(presence.isOnline("ada")).toBe(false);
    expect(presence.isOnline("grace")).toBe(true);
  });

  test("a read overtaken by a newer one is ignored", () => {
    const presence = new WorkspacePresence();
    const older = presence.beginRead();
    const newer = presence.beginRead();
    newer({ c2: client("c2", "grace") });
    older({ c1: client("c1", "ada") });
    expect(presence.isOnline("ada")).toBe(false);
    expect(presence.isOnline("grace")).toBe(true);
  });
});
