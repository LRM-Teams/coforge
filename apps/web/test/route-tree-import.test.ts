import { afterAll, expect, test } from "bun:test";

const saved = { database: Bun.env.DATABASE_URL, redis: Bun.env.REDIS_URL };

afterAll(() => {
  for (const [name, value] of [
    ["DATABASE_URL", saved.database],
    ["REDIS_URL", saved.redis],
  ] as const)
    if (value === undefined) delete Bun.env[name];
    else Bun.env[name] = value;
});

test("loading the route tree never starts the Agent activity sweep", async () => {
  // Everything that builds the router - tests included - imports every route module. The
  // Centrifugo RPC route composed its handler at import, which with a database configured starts
  // the Agent activity sweep and demands REDIS_URL before any request arrives.
  Bun.env.DATABASE_URL = "postgresql://coforge:coforge@127.0.0.1:1/unused";
  delete Bun.env.REDIS_URL;

  const { getRouter } = await import("#src/router");

  expect(getRouter().options.defaultPendingMs).toBeGreaterThan(0);
});
