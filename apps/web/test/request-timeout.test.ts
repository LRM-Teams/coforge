import { expect, test } from "bun:test";

import { extendRequestTimeout } from "#src/server/http/request-timeout.server";

test("asks the Bun server behind the request to wait longer before closing it as idle", () => {
  const calls: [Request, number][] = [];
  const request = new Request("http://app.test/_serverFn/x", { method: "POST" });
  Object.defineProperty(request, "runtime", {
    value: {
      name: "bun",
      bun: { server: { timeout: (req: Request, s: number) => calls.push([req, s]) } },
    },
  });
  expect(extendRequestTimeout(request, 300)).toBe(true);
  expect(calls).toEqual([[request, 300]]);
});

test("does nothing for a request no Bun server stands behind", () => {
  expect(extendRequestTimeout(new Request("http://app.test/"), 300)).toBe(false);
});
