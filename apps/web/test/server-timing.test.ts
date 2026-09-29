import { expect, test } from "bun:test";
import {
  recordDatabaseQuery,
  withServerTiming,
} from "#src/server/observability/server-timing.server";

const enabled = { COFORGE_SERVER_TIMING: "1" };

// W3C Server Timing: `metric-name *( OWS ";" OWS server-timing-param )`, comma-separated. The
// server sends exactly two fixed names, each with only a numeric `dur` and no `desc`.
const metric = /^(total|db);dur=\d+(\.\d+)?$/;

function metrics(response: Response): Map<string, number> {
  const value = response.headers.get("server-timing");
  if (value === null) throw new Error("no Server-Timing header");
  const entries = value.split(",").map((part) => part.trim());
  for (const entry of entries) expect(entry).toMatch(metric);
  return new Map(
    entries.map((entry) => {
      const [name, dur] = entry.split(";dur=");
      return [name, Number(dur)];
    }),
  );
}

function html() {
  return {
    response: new Response("<!doctype html>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  };
}

test("a Server Function response carries the handler's total and database time", async () => {
  const result = await withServerTiming(
    "serverFn",
    async () => {
      recordDatabaseQuery(100, 104.25);
      recordDatabaseQuery(110, 111.5);
      await Bun.sleep(20);
      return { response: Response.json({ ok: true }) };
    },
    enabled,
  );

  const timings = metrics(result.response);
  expect([...timings.keys()]).toEqual(["total", "db"]);
  expect(timings.get("db")).toBe(5.8);
  expect(timings.get("total")).toBeGreaterThanOrEqual(20);
});

test("db is the time at least one query was in flight, so overlapping queries count once", async () => {
  const result = await withServerTiming(
    "serverFn",
    () => {
      // Completion order, as Prisma reports them: [0,10] and [5,12] overlap, [20,25] stands apart.
      recordDatabaseQuery(5, 12);
      recordDatabaseQuery(0, 10);
      recordDatabaseQuery(20, 25);
      recordDatabaseQuery(21, 22);
      return { response: Response.json({}) };
    },
    enabled,
  );

  expect(metrics(result.response).get("db")).toBe(17);
});

test("an SSR document carries the header, a non-HTML server route does not", async () => {
  const document = await withServerTiming("router", html, enabled);
  expect(metrics(document.response).has("total")).toBe(true);

  const api = await withServerTiming(
    "router",
    () => ({ response: Response.json({ ok: true }) }),
    enabled,
  );
  expect(api.response.headers.has("server-timing")).toBe(false);
});

test("without COFORGE_SERVER_TIMING=1 no response carries the header", async () => {
  for (const env of [{}, { COFORGE_SERVER_TIMING: "0" }]) {
    const fn = await withServerTiming("serverFn", () => ({ response: Response.json({}) }), env);
    const document = await withServerTiming("router", html, env);
    expect(fn.response.headers.has("server-timing")).toBe(false);
    expect(document.response.headers.has("server-timing")).toBe(false);
  }
});

test("concurrent requests each count only their own queries", async () => {
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => (releaseA = resolve));

  const a = withServerTiming(
    "serverFn",
    async () => {
      recordDatabaseQuery(0, 10);
      await gateA;
      recordDatabaseQuery(20, 22);
      return { response: Response.json({}) };
    },
    enabled,
  );
  const b = withServerTiming(
    "serverFn",
    async () => {
      recordDatabaseQuery(0, 30);
      releaseA();
      return { response: Response.json({}) };
    },
    enabled,
  );
  // A query outside any request (a background sweep) is dropped, not added to one.
  recordDatabaseQuery(0, 1000);

  const [resultA, resultB] = await Promise.all([a, b]);
  expect(metrics(resultA.response).get("db")).toBe(12);
  expect(metrics(resultB.response).get("db")).toBe(30);
});

test("the header holds only metric names and durations, nothing from the request or response", async () => {
  const secret = "s3cr3t-token";
  const result = await withServerTiming(
    "serverFn",
    () => ({
      response: Response.json(
        { secret },
        { headers: { "x-request-id": secret, "set-cookie": `session=${secret}` } },
      ),
    }),
    enabled,
  );

  const value = result.response.headers.get("server-timing") ?? "";
  expect(value).not.toContain(secret);
  expect(value).not.toContain("desc");
  expect([...metrics(result.response).keys()]).toEqual(["total", "db"]);
});

test("a metric the handler already set is kept", async () => {
  const result = await withServerTiming(
    "serverFn",
    () => ({ response: Response.json({}, { headers: { "server-timing": "cache;desc=hit" } }) }),
    enabled,
  );

  const value = result.response.headers.get("server-timing") ?? "";
  expect(value.startsWith("cache;desc=hit, total;dur=")).toBe(true);
});
