import { describe, expect, test } from "bun:test";

import {
  arrangeTabs,
  isTabOrder,
  knownTabs,
  reorderTabs,
} from "#src/features/panel-tabs/panel-tab-order";
import {
  WorkspaceMemberPreferences,
  type WorkspaceMemberPreferencesRepository,
} from "#src/server/db/repositories/workspace-member-preferences.repositories.server";

describe("panel tab order", () => {
  test("shows the visible tabs in the saved order, then any unsaved ones in their default order", () => {
    expect(arrangeTabs(["chat", "tasks", "files"], [])).toEqual(["chat", "tasks", "files"]);
    expect(arrangeTabs(["chat", "tasks", "files"], ["files", "chat"])).toEqual([
      "files",
      "chat",
      "tasks",
    ]);
  });

  test("skips saved tabs the viewer cannot see", () => {
    expect(arrangeTabs(["profile", "workspace"], ["workspace", "activity", "profile"])).toEqual([
      "workspace",
      "profile",
    ]);
  });

  test("a saved id that is no longer a tab is dropped when read", () => {
    expect(knownTabs("agentProfile", ["workspace", "retired", "profile"])).toEqual([
      "workspace",
      "profile",
    ]);
  });

  test("a valid order lists only the panel's own tabs, each once", () => {
    expect(isTabOrder("conversation", ["files", "chat"])).toBeTrue();
    expect(isTabOrder("conversation", ["chat", "profile"])).toBeFalse();
    expect(isTabOrder("agentProfile", ["profile", "profile"])).toBeFalse();
  });

  test("a reorder among the visible tabs keeps hidden tabs in their saved slots", () => {
    const all = ["profile", "reminders", "activity", "workspace"];
    // A manager who does not own the Agent sees no Workspace tab, which the owner put first.
    expect(
      reorderTabs(
        all,
        ["workspace", "profile", "reminders", "activity"],
        ["activity", "profile", "reminders"],
      ),
    ).toEqual(["workspace", "activity", "profile", "reminders"]);
    // Nothing saved yet: the default order supplies the hidden tabs' slots.
    expect(reorderTabs(all, [], ["activity", "profile"])).toEqual([
      "activity",
      "reminders",
      "profile",
      "workspace",
    ]);
  });
});

describe("workspace member preferences", () => {
  function preferences() {
    const saved = { conversation: [] as string[], agentProfile: [] as string[] };
    const repository: WorkspaceMemberPreferencesRepository = {
      getTabOrders: async () => saved,
      setTabOrder: async (_workspaceId, _userId, panel, order) => {
        saved[panel] = order;
      },
    };
    return { members: new WorkspaceMemberPreferences(repository), saved };
  }

  test("reads empty orders until the member saves one", async () => {
    expect(await preferences().members.getTabOrders("workspace-1", "user-1")).toEqual({
      conversation: [],
      agentProfile: [],
    });
  });

  test("saves each panel's order for the member", async () => {
    const { members } = preferences();
    await members.setTabOrder("workspace-1", "user-1", "conversation", ["files", "chat", "tasks"]);
    await members.setTabOrder("workspace-1", "user-1", "agentProfile", ["activity", "profile"]);
    expect(await members.getTabOrders("workspace-1", "user-1")).toEqual({
      conversation: ["files", "chat", "tasks"],
      agentProfile: ["activity", "profile"],
    });
  });

  test("rejects an order with an unknown tab or a repeated one, and saves nothing", async () => {
    const { members, saved } = preferences();
    await expect(
      members.setTabOrder("workspace-1", "user-1", "conversation", ["chat", "profile"]),
    ).rejects.toThrow("INVALID_INPUT");
    await expect(
      members.setTabOrder("workspace-1", "user-1", "agentProfile", ["profile", "profile"]),
    ).rejects.toThrow("INVALID_INPUT");
    expect(saved).toEqual({ conversation: [], agentProfile: [] });
  });
});
