import { beforeEach, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { isNotFound, isRedirect } from "@tanstack/react-router";

import { AppError } from "#src/lib/app-error";

// Where a visitor lands is decided by two server reads: whether they are signed in, and the page
// `/` opens for them (`null` when they are in no Workspace). Both are stood in for here.
let signedIn = false;
let startPage: string | null = null;

mock.module("#src/features/auth/current-user.functions", () => ({
  getAuthenticationStatus: async () => signedIn,
  getSignedInEmail: async () => (signedIn ? "ada@example.com" : null),
}));
mock.module("#src/features/workspaces/last-location.functions", () => ({
  getStartPage: async () => startPage,
}));
const workspaceFunctions = await import("#src/features/workspaces/workspaces.functions");
mock.module("#src/features/workspaces/workspaces.functions", () => ({
  ...workspaceFunctions,
  openWorkspace: async () => {
    throw new AppError("NOT_FOUND");
  },
}));

const { Route: rootPage } = await import("#src/routes/index");
const { Route: workspaceLayout } = await import("#src/routes/w.$workspaceSlug");
const { Route: firstWorkspacePage } = await import("#src/routes/workspaces.new");

beforeEach(() => {
  signedIn = false;
  startPage = null;
});

async function landing(
  beforeLoad: ((args: never) => unknown) | undefined,
  args: object,
): Promise<unknown> {
  expect(beforeLoad).toBeDefined();
  try {
    await beforeLoad!({
      context: { queryClient: new QueryClient() },
      preload: false,
      ...args,
    } as never);
  } catch (thrown) {
    return thrown;
  }
  return undefined;
}

function redirectTarget(thrown: unknown): string | undefined {
  if (!isRedirect(thrown)) return undefined;
  return thrown.options.href ?? String(thrown.options.to);
}

const atRoot = { location: { searchStr: "" } };

test("a signed-in person in no Workspace is sent from `/` to create their first one", async () => {
  signedIn = true;
  expect(redirectTarget(await landing(rootPage.options.beforeLoad, atRoot))).toBe(
    "/workspaces/new",
  );
});

test("a signed-in person with a Workspace still opens it from `/`", async () => {
  signedIn = true;
  startPage = "/w/acme/tasks";
  expect(redirectTarget(await landing(rootPage.options.beforeLoad, atRoot))).toContain(
    "/w/acme/tasks",
  );
});

test("a signed-out visitor stays on the public home page", async () => {
  expect(await landing(rootPage.options.beforeLoad, atRoot)).toBeUndefined();
});

test("a Workspace URL a person in no Workspace cannot open sends them to create their first one", async () => {
  signedIn = true;
  const thrown = await landing(workspaceLayout.options.beforeLoad, {
    params: { workspaceSlug: "gone" },
  });
  expect(redirectTarget(thrown)).toBe("/workspaces/new");
});

test("a Workspace URL that is not theirs is still not found for a person with Workspaces", async () => {
  signedIn = true;
  startPage = "/w/acme";
  const thrown = await landing(workspaceLayout.options.beforeLoad, {
    params: { workspaceSlug: "gone" },
  });
  expect(isNotFound(thrown)).toBe(true);
});

test("the first-Workspace page shows for a signed-in person in no Workspace", async () => {
  signedIn = true;
  expect(await landing(firstWorkspacePage.options.beforeLoad, {})).toBeUndefined();
});

test("the first-Workspace page sends a person who has Workspaces back to theirs", async () => {
  signedIn = true;
  startPage = "/w/acme";
  expect(redirectTarget(await landing(firstWorkspacePage.options.beforeLoad, {}))).toContain(
    "/w/acme",
  );
});

test("the first-Workspace page asks a signed-out visitor to sign in", async () => {
  expect(redirectTarget(await landing(firstWorkspacePage.options.beforeLoad, {}))).toBe("/login");
});
