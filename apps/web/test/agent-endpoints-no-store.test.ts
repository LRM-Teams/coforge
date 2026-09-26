import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Guards one convention for the viewer- and agent-scoped server functions: every function in the
 * guarded files declares `declareNoStore()`, so the payload is never cached. The guarded set is the
 * `agent-*.functions.ts` family in `features/agents`, plus the non-agent files that already spell
 * the header — listed in `EXTRA_FILES`. Counted per file against `createServerFn(` rather than
 * parsed, which is enough because each function in these files declares it at the top of its
 * handler.
 *
 * `agents.functions.ts` (plural) is deliberately out of scope: those are the UI's own server
 * functions, and most of them are not viewer-facing responses at all.
 *
 * A gap is allowed only when it is listed below — and a listed gap that no longer exists **fails**
 * this test, so the list cannot rot into a permanent exemption.
 */
const AGENT_FUNCTIONS_DIRECTORY = join(import.meta.dir, "../src/features/agents");
const FEATURES_DIRECTORY = join(import.meta.dir, "../src/features");
const EXTRA_GUARDED_FILES = [
  "auth/current-user.functions.ts",
  "workspaces/last-location.functions.ts",
  "integrations/github.functions.ts",
];

/** Files still missing a declaration, with the call that owns them. */
const KNOWN_GAPS: Readonly<Record<string, string>> = {
  // Defines two server functions and declares the header in one; adding it to the second turns a
  // cacheable endpoint into an uncacheable one, so it waits on the owner rather than riding along
  // with a mechanical change.
  "agent-context-report.functions.ts": "second function undeclared",
  // Declares it in one of nine. The other eight are connection-flow endpoints (POST handlers and
  // listing reads) whose cacheability is the owner's behavior call, not a mechanical rider.
  "github.functions.ts": "8 flow endpoints undeclared",
};

/** Comments are stripped before counting: a comment that mentions `declareNoStore()` would otherwise
 * inflate a file's declaration count and could mask a function that never calls it (caught in review
 * of the first version of this guard). */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("every agent-facing server function declares declareNoStore()", async () => {
  const files = [
    ...(await readdir(AGENT_FUNCTIONS_DIRECTORY))
      .filter((name) => name.startsWith("agent-") && name.endsWith(".functions.ts"))
      .map((name) => join(AGENT_FUNCTIONS_DIRECTORY, name)),
    ...EXTRA_GUARDED_FILES.map((relative) => join(FEATURES_DIRECTORY, relative)),
  ].sort();
  expect(files.length).toBeGreaterThan(0);

  const unexplained: string[] = [];
  const stale: string[] = [];

  for (const path of files) {
    const name = path.split("/").pop() as string;
    const source = withoutComments(await readFile(path, "utf8"));
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
