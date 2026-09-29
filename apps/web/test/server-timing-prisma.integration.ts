import { expect, test } from "bun:test";

// Prisma documents the `query` event and its millisecond `duration`
// (https://www.prisma.io/docs/orm/prisma-client/observability-and-logging/logging), but not that
// the event fires in the async context of the query's caller. Server-Timing attributes queries to
// requests through that context (`AsyncLocalStorage`), so this runs real queries through the app's
// own client: an upgrade that emits the event elsewhere fails here instead of silently reporting
// `db;dur=0` or charging one request's queries to another.
test("a real Prisma query is attributed to the request that issued it, not a concurrent one", async () => {
  if (!Bun.env.DATABASE_URL) throw new Error("DATABASE_URL must point to local PostgreSQL");
  process.env.COFORGE_SERVER_TIMING = "1";
  const { requireDatabaseClient } = await import("#src/server/db/client.server");
  const { withServerTiming } = await import("#src/server/observability/server-timing.server");
  const db = requireDatabaseClient();

  const timed = (work: () => Promise<unknown>) =>
    withServerTiming("serverFn", async () => {
      await work();
      return { response: new Response("{}") };
    });
  const database = (header: string | null) => Number(/db;dur=([\d.]+)/.exec(header ?? "")?.[1]);

  const [querying, idle] = await Promise.all([
    timed(() => db.$queryRaw`SELECT 1 AS done FROM pg_sleep(0.15)`),
    timed(() => Bun.sleep(150)),
  ]);

  expect(database(querying.response.headers.get("server-timing"))).toBeGreaterThanOrEqual(140);
  expect(database(idle.response.headers.get("server-timing"))).toBe(0);
});
