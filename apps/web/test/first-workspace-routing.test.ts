import { beforeEach, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { isNotFound, isRedirect } from "@tanstack/react-router";

import { AppError } from "#src/lib/app-error";

// Where a visitor lands is decided by three server reads: whether they are signed in, the page
// `/` opens for them (`null` when they are in no Workspace), and — after signing out to switch
// account — the page a returning browser should sign in to again. All three are stood in for.
let signedIn = false;
// Whether the signed-in person has been asked for a full name (`User.fullName` is set).
let named = true;
let startPage: string | null = null;

mock.module("#src/features/auth/current-user.functions", () => ({
  getAuthenticationStatus: async () => signedIn,
  // The signed-in person is one with no email address (a phone-number sign-up), named by their
  // name: having no email does not make them a signed-out visitor.
  getSignedInAccount: async () => (signedIn ? { account: "Ada Lovelace", named } : null),
}));
mock.module("#src/features/profiles/profile.functions", () => ({
  getUserProfile: async () => ({ id: "user-1", name: "Ada Lovelace", named }),
}));
mock.module("#src/features/workspaces/last-location.functions", () => ({
  getStartPage: async () => startPage,
}));
mock.module("#src/features/auth/logout-return.functions", () => ({
  // The switch-account resume read: the tests only judge the signed-in and plain signed-out
  // landings, so the cookie is always absent.
  takeLogoutReturn: async () => null,
}));
const workspaceFunctions = await import("#src/features/workspaces/workspaces.functions");
mock.module("#src/features/workspaces/workspaces.functions", () => ({
  ...workspaceFunctions,
  openWorkspace: async () => {
    throw new AppError("NOT_FOUND");
  },
  loadWorkspaceSwitcher: async () => ({
    workspaces: [],
    current: { id: "workspace-1", slug: "acme", name: "Acme" },
  }),
}));
// The Workspace layout's other reads: they only have to answer for the layout to load.
const workspaceReads = {
  "#src/features/notifications/notifications.functions": { getBrowserNotificationSettings: {} },
  "#src/features/agents/agents.functions": { listAgents: [] },
  "#src/features/settings/settings.functions": { getUserPreferences: {} },
  "#src/features/panel-tabs/panel-tabs.functions": { getPanelTabOrders: {} },
  "#src/features/records/records.functions": { loadRecordsNavAttention: { preview: false } },
} as const;
for (const [path, reads] of Object.entries(workspaceReads)) {
  const real = await import(path);
  mock.module(path, () => ({
    ...real,
    ...Object.fromEntries(Object.entries(reads).map(([name, value]) => [name, async () => value])),
  }));
}
mock.module("#src/features/settings/assumed-viewport.functions", () => ({
  // Read from the request on a real server; nothing here is a phone.
  loadAssumedPhone: () => false,
}));
let joinPreview: unknown = null;
const joinFunctions = await import("#src/features/workspaces/join-links.functions");
mock.module("#src/features/workspaces/join-links.functions", () => ({
  ...joinFunctions,
  inspectWorkspaceJoinLink: async () => joinPreview,
}));

const { Route: rootPage } = await import("#src/routes/index");
const { Route: workspaceLayout } = await import("#src/routes/w.$workspaceSlug");
const { Route: firstWorkspacePage } = await import("#src/routes/workspaces.new");
const { Route: joinPage } = await import("#src/routes/join.$token");

beforeEach(() => {
  signedIn = false;
  named = true;
  startPage = null;
  joinPreview = null;
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

/** Where a redirect goes to (`/welcome`) and what it carries as `returnTo`. */
function nameStepTarget(thrown: unknown): { to?: string; returnTo?: string } | undefined {
  if (!isRedirect(thrown)) return undefined;
  const search = thrown.options.search as { returnTo?: string } | undefined;
  return { to: String(thrown.options.to), returnTo: search?.returnTo };
}

async function loaded(loader: unknown, args: object): Promise<unknown> {
  if (typeof loader !== "function") throw new Error("the route has no loader function");
  try {
    return await loader(args);
  } catch (thrown) {
    return thrown;
  }
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

// A signed-in person who has not been asked for a full name is sent to `/welcome` once, from
// every page that would otherwise make their personal Workspace or open one: the answer titles it.

test("the first-Workspace page asks an unnamed person for their name first", async () => {
  signedIn = true;
  named = false;
  expect(nameStepTarget(await landing(firstWorkspacePage.options.beforeLoad, {}))).toEqual({
    to: "/welcome",
    returnTo: "/workspaces/new",
  });
});

test("an invite link asks an unnamed person for their name first, and comes back to the link", async () => {
  signedIn = true;
  named = false;
  joinPreview = { name: "Acme" };
  const thrown = await loaded(joinPage.options.loader, { params: { token: "abc123" } });
  expect(nameStepTarget(thrown)).toEqual({ to: "/welcome", returnTo: "/join/abc123" });
});

test("an invite link is shown as it is to a named person, and to a signed-out visitor", async () => {
  joinPreview = { name: "Acme" };
  expect(await loaded(joinPage.options.loader, { params: { token: "abc123" } })).toEqual({
    preview: { name: "Acme" },
    viewerAccount: null,
  });
  signedIn = true;
  expect(await loaded(joinPage.options.loader, { params: { token: "abc123" } })).toEqual({
    preview: { name: "Acme" },
    viewerAccount: "Ada Lovelace",
  });
});

test("the Workspace layout asks an unnamed person for their name first, and comes back to the page", async () => {
  signedIn = true;
  named = false;
  const thrown = await loaded(workspaceLayout.options.loader, {
    location: { href: "/w/acme/channel/general?thread=1" },
  });
  expect(nameStepTarget(thrown)).toEqual({
    to: "/welcome",
    returnTo: "/w/acme/channel/general?thread=1",
  });
});

test("the Workspace layout loads for a named person", async () => {
  signedIn = true;
  const result = await loaded(workspaceLayout.options.loader, {
    location: { href: "/w/acme/tasks" },
  });
  expect(isRedirect(result)).toBe(false);
  expect(result).toMatchObject({ user: { id: "user-1" } });
});
