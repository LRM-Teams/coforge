import { afterEach, expect, test } from "bun:test";

import { redisUrlFor } from "#src/server/redis-url.server";

const original = Bun.env.REDIS_URL;

afterEach(() => {
  if (original === undefined) delete Bun.env.REDIS_URL;
  else Bun.env.REDIS_URL = original;
});

test("returns the configured URL", () => {
  Bun.env.REDIS_URL = "redis://example.invalid:6379";
  expect(redisUrlFor("anything")).toBe("redis://example.invalid:6379");
});

test("names the feature that needed it when REDIS_URL is unset", () => {
  delete Bun.env.REDIS_URL;
  expect(() => redisUrlFor("Computer status")).toThrow("REDIS_URL is required for Computer status");
});
