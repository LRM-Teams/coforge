import { expect, test } from "bun:test";
import { noStore } from "#src/server/agents/agent-http-middleware.server";

const header = "cache-control";

test("noStore adds cache-control: no-store", () => {
  const response = new Response("body", { status: 200 });
  expect(noStore(response).headers.get(header)).toBe("no-store");
});

test("noStore preserves the status, the status text and the other headers", () => {
  const response = new Response("body", {
    status: 201,
    statusText: "Created",
    headers: { "content-type": "application/json", "x-existing": "kept" },
  });

  const copied = noStore(response);

  expect(copied.status).toBe(201);
  expect(copied.statusText).toBe("Created");
  expect(copied.headers.get("content-type")).toBe("application/json");
  expect(copied.headers.get("x-existing")).toBe("kept");
});

test("noStore rebuilds the response rather than mutating the one it was handed", () => {
  const response = new Response("body", { headers: { [header]: "public, max-age=60" } });

  const copied = noStore(response);

  expect(copied.headers.get(header)).toBe("no-store");
  // The caller's response keeps whatever it said: the middleware replaces the field it returns, and a
  // route that set its own value is not silently edited out from under it.
  expect(response.headers.get(header)).toBe("public, max-age=60");
});
