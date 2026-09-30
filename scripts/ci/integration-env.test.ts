import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The Web integration suites only run when someone points a scratch database at them, and each one
 * checks its own `<AREA>_TEST_DATABASE_URL` (plus a redis one for two of them) - a set whose
 * only teacher is a failure at run time, and whose size is not worth restating here because it grows. `scripts/test/run-web-integration.sh` sets them all from a
 * single variable, and this checks its list still covers every name the suites actually read, so a
 * new suite area fails here, at review, instead of in a run that nobody performs (CI has no
 * PostgreSQL, so these suites never run there).
 */
const NAME = /\b[A-Z][A-Z0-9_]*(?:_TEST_DATABASE_URL|_TEST_REDIS_URL)\b/g;

const root = (path: string) => join(import.meta.dir, "../..", path);

test("the integration runner sets every test URL the suites read", async () => {
  const directory = root("apps/web/test");
  const files = (await readdir(directory)).filter((name) => name.includes(".integration"));
  const runner = await readFile(root("scripts/test/run-web-integration.sh"), "utf8");

  const names = new Set<string>();
  for (const file of files) {
    const source = await readFile(join(directory, file), "utf8");
    for (const match of source.matchAll(NAME)) names.add(match[0]);
  }

  // Non-vacuity: if the filter or the pattern stops matching, this test must not pass by finding
  // nothing to check.
  expect(files.length).toBeGreaterThan(50);
  expect(names.size).toBeGreaterThan(10);

  const missing = [...names].filter((name) => !runner.includes(name)).sort();
  expect(missing).toEqual([]);
});
