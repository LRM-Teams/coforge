import "./dom-setup";

import { afterEach, expect, test } from "bun:test";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import { Route as ComputerIndexRoute } from "@/routes/_app/computers.index";

afterEach(() => {
  cleanup();
  window.innerWidth = 1024;
});

async function openIndex(path = "/computers", computers = [{ id: "first" }, { id: "second" }]) {
  const root = createRootRoute();
  const app = createRoute({ getParentRoute: () => root, id: "_app" });
  const parent = createRoute({
    getParentRoute: () => app,
    path: "/computers",
    loader: () => ({ computers }),
    component: () => <Outlet />,
  });
  const index = createRoute({
    getParentRoute: () => parent,
    path: "/",
    component: ComputerIndexRoute.options.component,
  });
  const detail = createRoute({
    getParentRoute: () => parent,
    path: "$computerId",
    component: () => <p>Computer detail</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([parent.addChildren([index, detail])])]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await act(() => router.load());
  render(<RouterProvider router={router} />);
  return router;
}

test("mobile Computer index stays on the list instead of selecting the first Computer", async () => {
  window.innerWidth = 767;
  const router = await openIndex();
  expect(router.state.location.pathname).toBe("/computers");
});

test("desktop Computer index retains first-Computer selection", async () => {
  window.innerWidth = 768;
  const router = await openIndex();
  await waitFor(() => expect(router.state.location.pathname).toBe("/computers/first"));
});

test("mobile direct links keep the requested Computer", async () => {
  window.innerWidth = 390;
  const router = await openIndex("/computers/second");
  expect(router.state.location.pathname).toBe("/computers/second");
});

test("an empty Computer list does not navigate on desktop", async () => {
  window.innerWidth = 1280;
  const router = await openIndex("/computers", []);
  expect(router.state.location.pathname).toBe("/computers");
});
