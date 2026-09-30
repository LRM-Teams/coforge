import { beforeEach, expect, mock, test } from "bun:test";
import { isRedirect } from "@tanstack/react-router";

// Where `/welcome` sends a person: on when they have a full name, back to sign-in when their
// session outlived their user, and otherwise nowhere — the name step is for them. The one server
// read that decides it is stood in for.
type NameStep =
  | { status: "named" }
  | { status: "ask"; prefill: string }
  | { status: "account_gone" };
let step: NameStep = { status: "ask", prefill: "" };

mock.module("#src/features/auth/first-sign-in.functions", () => ({
  getNameStep: async () => step,
  submitFullName: async () => ({ ok: true }),
}));

const { Route } = await import("#src/routes/welcome");

beforeEach(() => {
  step = { status: "ask", prefill: "" };
});

async function enter(search: { returnTo?: string }): Promise<unknown> {
  const beforeLoad = Route.options.beforeLoad;
  if (!beforeLoad) throw new Error("the route has no beforeLoad");
  try {
    return await beforeLoad({ search } as never);
  } catch (thrown) {
    return thrown;
  }
}

function redirectOptions(thrown: unknown) {
  if (!isRedirect(thrown)) throw new Error(`not a redirect: ${String(thrown)}`);
  return thrown.options;
}

function validate(search: Record<string, unknown>) {
  const validateSearch = Route.options.validateSearch;
  if (typeof validateSearch !== "function") throw new Error("the route has no search validator");
  return validateSearch(search);
}

// `returnTo` is where a person goes after answering, so only a page of this site is one.

test("a return path that could leave the site is dropped, and a page of the site is kept", () => {
  expect(validate({ returnTo: "//evil.com" })).toEqual({ returnTo: undefined });
  expect(validate({ returnTo: "https://evil.com" })).toEqual({ returnTo: undefined });
  expect(validate({ returnTo: "/\\evil" })).toEqual({ returnTo: undefined });
  expect(validate({ returnTo: 42 })).toEqual({ returnTo: undefined });
  expect(validate({})).toEqual({ returnTo: undefined });
  expect(validate({ returnTo: "/join/abc?x=1" })).toEqual({ returnTo: "/join/abc?x=1" });
});

test("a person who has a full name is sent straight on, to the page they were going to", async () => {
  step = { status: "named" };
  expect(redirectOptions(await enter({ returnTo: "/w/acme/tasks" })).href).toBe("/en/w/acme/tasks");
  // With no page in mind, the app's own start page.
  expect(redirectOptions(await enter({})).href).toBe("/en");
});

test("a person who has none is asked, starting from what the provider reported", async () => {
  step = { status: "ask", prefill: "Ada Lovelace" };
  expect(await enter({ returnTo: "/join/abc" })).toEqual({ prefill: "Ada Lovelace" });
});

test("a session whose user is gone signs in again, and comes back to where it was going", async () => {
  step = { status: "account_gone" };
  const options = redirectOptions(await enter({ returnTo: "/join/abc" }));
  // A document load, not a router step: `/auth/login` is a server route.
  expect(options.href).toBe(`/auth/login?returnTo=${encodeURIComponent("/join/abc")}`);
  expect(options.reloadDocument).toBe(true);

  expect(redirectOptions(await enter({})).href).toBe("/auth/login");
});
