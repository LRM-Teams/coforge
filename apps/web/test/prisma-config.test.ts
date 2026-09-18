import { expect, test } from "bun:test";

import { prismaDatasource } from "../prisma.config";

test("production migration config never reuses the main database as its shadow", () => {
  expect(
    prismaDatasource({ DATABASE_URL: "postgresql://db/coforge" } as NodeJS.ProcessEnv),
  ).toEqual({ url: "postgresql://db/coforge" });
});

test("an explicit local shadow database remains available for migration diff", () => {
  expect(
    prismaDatasource({
      DATABASE_URL: "postgresql://db/coforge",
      SHADOW_DATABASE_URL: "postgresql://db/coforge_shadow",
    } as NodeJS.ProcessEnv),
  ).toEqual({
    url: "postgresql://db/coforge",
    shadowDatabaseUrl: "postgresql://db/coforge_shadow",
  });
});
