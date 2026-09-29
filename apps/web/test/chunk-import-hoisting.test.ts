import { expect, test } from "bun:test";
import { hoistTransitiveChunkImports } from "../scripts/hoist-transitive-chunk-imports";

/**
 * `widen`/`restore` exist because Start builds each route's `modulepreload` links from
 * `chunk.imports`, and Rolldown lists direct imports only (see the module's own comment). Two
 * things about the pair are load-bearing, and both fail **silently** - a performance regression,
 * not a broken build - so they are pinned here instead of living only in a comment:
 *
 * 1. `widen` must list the whole static closure. Listing direct imports only is precisely the bug
 *    it exists to fix, and the build still succeeds.
 * 2. `restore` must **assign**, never mutate in place: Start's client-bundle capture stores the
 *    very array `widen` assigned, by reference (`@tanstack/start-plugin-core` 1.171.39). Emptying
 *    or trimming that array after the capture would leave the manifest built from nothing.
 *
 * It also encodes why `restore` matches by file name: Rolldown hands each hook its own chunk
 * objects, so the objects `widen` saw are not the ones `restore` receives.
 */
type Chunk = { type: "chunk"; fileName: string; imports: string[] };

function bundleOf(...chunks: Chunk[]): Record<string, Chunk> {
  return Object.fromEntries(chunks.map((chunk) => [chunk.fileName, chunk]));
}

// a.js -> b.js -> c.js, so the direct list and the closure differ by exactly one file.
const chain = () => [
  { type: "chunk" as const, fileName: "a.js", imports: ["b.js"] },
  { type: "chunk" as const, fileName: "b.js", imports: ["c.js"] },
  { type: "chunk" as const, fileName: "c.js", imports: [] },
];

/** Runs a plugin hook. `generateBundle` is typed as an object hook, which may also be
 * `{ handler, order }`; the pair relies on the plain form, so that is pinned rather than cast
 * away. */
function run(plugin: { generateBundle?: unknown }, bundle: unknown): void {
  const hook = plugin.generateBundle;
  if (typeof hook !== "function") throw new Error("generateBundle must be a plain function");
  (hook as (options: unknown, bundle: unknown, write: boolean) => void)({}, bundle, false);
}

const hooks = () => {
  const plugins = hoistTransitiveChunkImports();
  const widen = plugins.find((plugin) => plugin.name === "hoist-transitive-chunk-imports:widen");
  const restore = plugins.find(
    (plugin) => plugin.name === "hoist-transitive-chunk-imports:restore",
  );
  expect(widen?.generateBundle).toBeFunction();
  expect(restore?.generateBundle).toBeFunction();
  return { widen: widen!, restore: restore! };
};

test("widen lists the static closure, and the array Start captures keeps it", () => {
  const { widen, restore } = hooks();
  const seen = bundleOf(...chain());

  run(widen, seen);
  expect(seen["a.js"]!.imports).toEqual(["b.js", "c.js"]);
  expect(seen["b.js"]!.imports).toEqual(["c.js"]);

  // What Start's manifest capture stores, before `restore` runs.
  const captured = seen["a.js"]!.imports;

  // Rolldown's second pass hands `restore` its own objects for the same file names.
  const second = bundleOf(...chain());
  run(restore, second);

  // Vite's own post plugins see the direct list again...
  expect(second["a.js"]!.imports).toEqual(["b.js"]);
  // ...while the array the manifest was built from still holds the closure.
  expect(captured).toEqual(["b.js", "c.js"]);
  expect(second["a.js"]!.imports).not.toBe(captured);
});

test("restore leaves the captured array alone even when handed the same chunk objects", () => {
  // Rolldown gives each hook its own objects, but that is an internal of the bundler, not a
  // guarantee the plugin may rely on: assigning is safe either way, mutating in place would empty
  // the array the manifest was built from. Pinning it is what makes "assign, never mutate" a
  // contract rather than a comment.
  const { widen, restore } = hooks();
  const same = bundleOf(...chain());
  run(widen, same);
  const captured = same["a.js"]!.imports;
  run(restore, same);
  expect(same["a.js"]!.imports).toEqual(["b.js"]);
  expect(captured).toEqual(["b.js", "c.js"]);
});

test("a second widen/restore cycle starts from the bundle it is given, not from the last one", () => {
  const { widen, restore } = hooks();
  const first = bundleOf(...chain());
  run(widen, first);
  run(restore, first);

  const later = bundleOf(
    { type: "chunk", fileName: "a.js", imports: ["b.js"] },
    { type: "chunk", fileName: "b.js", imports: [] },
  );
  run(widen, later);
  expect(later["a.js"]!.imports).toEqual(["b.js"]);
});
