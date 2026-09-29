import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { enterWorkspace } from "#src/features/workspaces/shown-workspace";

function opener(ids: Record<string, string>) {
  const opened: string[] = [];
  return {
    opened,
    open: (slug: string) => async () => {
      opened.push(slug);
      return { workspaceId: ids[slug]! };
    },
  };
}

describe("entering the Workspace a page URL names", () => {
  test("a first entry opens it and hands its id to the pages below", async () => {
    const queryClient = new QueryClient();
    const { opened, open } = opener({ acme: "workspace-1" });

    expect(
      await enterWorkspace(queryClient, "acme", { preload: false, open: open("acme") }),
    ).toEqual({ workspaceId: "workspace-1" });
    expect(opened).toEqual(["acme"]);
  });

  test("moving within the Workspace on screen, or preloading there, knows its id without a call", async () => {
    const queryClient = new QueryClient();
    const { opened, open } = opener({ acme: "workspace-1" });
    await enterWorkspace(queryClient, "acme", { preload: false, open: open("acme") });

    for (const preload of [false, true])
      expect(await enterWorkspace(queryClient, "acme", { preload, open: open("acme") })).toEqual({
        workspaceId: "workspace-1",
      });
    expect(opened).toEqual(["acme"]);
  });

  test("a preload into another Workspace neither opens it nor clears the one on screen", async () => {
    const queryClient = new QueryClient();
    const { opened, open } = opener({ acme: "workspace-1", beta: "workspace-2" });
    await enterWorkspace(queryClient, "acme", { preload: false, open: open("acme") });
    queryClient.setQueryData(["held"], 1);

    expect(
      await enterWorkspace(queryClient, "beta", { preload: true, open: open("beta") }),
    ).toEqual({ workspaceId: undefined });
    expect(queryClient.getQueryData<number>(["held"])).toBe(1);
    // The Workspace on screen is still the one known without a call.
    expect(
      await enterWorkspace(queryClient, "acme", { preload: false, open: open("acme") }),
    ).toEqual({ workspaceId: "workspace-1" });
    expect(opened).toEqual(["acme"]);
  });

  test("going to another Workspace starts from an empty cache", async () => {
    const queryClient = new QueryClient();
    const { opened, open } = opener({ acme: "workspace-1", beta: "workspace-2" });
    await enterWorkspace(queryClient, "acme", { preload: false, open: open("acme") });
    queryClient.setQueryData(["held"], 1);

    expect(
      await enterWorkspace(queryClient, "beta", { preload: false, open: open("beta") }),
    ).toEqual({ workspaceId: "workspace-2" });
    expect(queryClient.getQueryData(["held"])).toBeUndefined();
    // Moving within the new Workspace knows its id without another call.
    await enterWorkspace(queryClient, "beta", { preload: true, open: open("beta") });
    expect(opened).toEqual(["acme", "beta"]);
  });

  test("a Workspace that fails to open is not marked as shown", async () => {
    const queryClient = new QueryClient();
    const refused = async (): Promise<{ workspaceId: string }> => {
      throw new Error("NOT_FOUND");
    };

    await expect(
      enterWorkspace(queryClient, "acme", { preload: false, open: refused }),
    ).rejects.toThrow("NOT_FOUND");
    // So a preload there still has no id, and the next navigation opens it again.
    expect(await enterWorkspace(queryClient, "acme", { preload: true, open: refused })).toEqual({
      workspaceId: undefined,
    });
  });
});
