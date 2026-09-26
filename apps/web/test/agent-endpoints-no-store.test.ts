import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Guards one convention for the agent-facing server functions: every function defined in an
 * `agent-*.functions.ts` declares `declareNoStore()`, so an Agent's payload is never cached. It is
 * counted per file against `createServerFn(` rather than parsed, which is enough because each
 * function in these files declares it at the top of its handler.
 *
 * `agents.functions.ts` (plural) is deliberately out of scope: those are the UI's own server
 * functions, and most of them are not agent-facing responses at all.
 *
 * A gap is allowed only when it is listed below — and a listed gap that no longer exists **fails**
 * this test, so the list cannot rot into a permanent exemption.
 */
const AGENT_FUNCTIONS_DIRECTORY = join(import.meta.dir, "../src/features/agents");

/** Files still missing a declaration, with the call that owns them. */
const KNOWN_GAPS: Readonly<Record<string, string>> = {
  // Defines two server functions and declares the header in one; adding it to the second turns a
  // cacheable endpoint into an uncacheable one, so it waits on the owner rather than riding along
  // with a mechanical change.
  "agent-context-report.functions.ts": "second function undeclared",
};

/** Comments are stripped before counting: a comment that mentions `declareNoStore()` would otherwise
 * inflate a file's declaration count and could mask a function that never calls it (caught in review
 * of the first version of this guard). */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("every agent-facing server function declares declareNoStore()", async () => {
  const files = (await readdir(AGENT_FUNCTIONS_DIRECTORY))
    .filter((name) => name.startsWith("agent-") && name.endsWith(".functions.ts"))
    .sort();
  expect(files.length).toBeGreaterThan(0);

  const unexplained: string[] = [];
  const stale: string[] = [];

  for (const name of files) {
    const source = withoutComments(await readFile(join(AGENT_FUNCTIONS_DIRECTORY, name), "utf8"));
    const functions = source.match(/createServerFn\(/g)?.length ?? 0;
    const declarations = source.split("declareNoStore()").length - 1;
    const gap = functions - declarations;

    if (gap === 0) {
      if (name in KNOWN_GAPS) stale.push(name);
      continue;
    }
    if (!(name in KNOWN_GAPS))
      unexplained.push(`${name}: ${functions} functions, ${declarations} declared`);
  }

  expect({ unexplained }).toEqual({ unexplained: [] });
  expect({ stale }).toEqual({ stale: [] });
});
