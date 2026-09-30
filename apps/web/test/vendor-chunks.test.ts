import { expect, test } from "bun:test";
import {
  assertLibraryChunksDoNotImportAppChunks,
  vendorChunkGroups,
} from "../scripts/vendor-chunks";

/**
 * The vendor chunks exist so a library's bytes keep their hash when only app code changes. Two
 * things break that without failing the build (a cycle between chunks can also fail the page at
 * load, as Rolldown's manual code splitting guide warns), so they are pinned here:
 *
 * 1. A chunk made only of `node_modules` code must never import a chunk that holds app code:
 *    its hash would then follow the app's (a silent regression), and when the app chunk imports
 *    it back the two form a cycle. TanStack Start's `hydrateStart` imports the app's `router.tsx`,
 *    and a trial build with it in a vendor chunk formed exactly that cycle with the entry chunk.
 * 2. No vendor group may capture the TanStack Start runtime, for that same reason.
 */
type Chunk = {
  type: "chunk";
  fileName: string;
  imports: string[];
  modules: Record<string, object>;
};

const chunk = (fileName: string, imports: string[], ...moduleIds: string[]): Chunk => ({
  type: "chunk",
  fileName,
  imports,
  modules: Object.fromEntries(moduleIds.map((id) => [id, {}])),
});

const lib = (name: string) => `/repo/node_modules/.bun/${name}@1.0.0/node_modules/${name}/index.js`;
const app = (path: string) => `/repo/apps/web/src/${path}`;

/** Runs the guard the way Rolldown does: `this.error` throws. */
function run(bundle: Record<string, Chunk>): void {
  const hook = assertLibraryChunksDoNotImportAppChunks().generateBundle;
  if (typeof hook !== "function") throw new Error("generateBundle must be a plain function");
  const context = {
    error(message: string) {
      throw new Error(message);
    },
  };
  (hook as (this: typeof context, options: unknown, bundle: unknown, write: boolean) => void).call(
    context,
    {},
    bundle,
    false,
  );
}

const bundleOf = (...chunks: Chunk[]) => Object.fromEntries(chunks.map((c) => [c.fileName, c]));

test("a library-only chunk that imports an app chunk fails the build and names both", () => {
  const bundle = bundleOf(
    chunk("assets/vendor-tanstack-a.js", ["assets/index-b.js"], lib("@tanstack/router-core")),
    chunk("assets/index-b.js", ["assets/vendor-tanstack-a.js"], app("router.tsx")),
  );
  expect(() => run(bundle)).toThrow(/vendor-tanstack-a\.js.*index-b\.js/s);
});

test("library chunks may import library chunks and the virtual runtime", () => {
  const bundle = bundleOf(
    chunk("assets/rolldown-runtime-a.js", [], "\0rolldown/runtime.js"),
    chunk(
      "assets/preload-helper-a.js",
      ["assets/rolldown-runtime-a.js"],
      "\0vite/preload-helper.js",
    ),
    chunk(
      "assets/vendor-b.js",
      ["assets/rolldown-runtime-a.js", "assets/preload-helper-a.js", "assets/vendor-c.js"],
      lib("mermaid"),
    ),
    chunk("assets/vendor-c.js", ["assets/rolldown-runtime-a.js"], lib("dompurify")),
    chunk("assets/app-d.js", ["assets/vendor-b.js"], app("features/x.ts")),
  );
  expect(() => run(bundle)).not.toThrow();
});

test("a chunk that holds an app module is an app chunk, even with library code beside it", () => {
  const bundle = bundleOf(
    chunk(
      "assets/index-a.js",
      ["assets/app-b.js"],
      app("client.tsx"),
      lib("@tanstack/start-client-core"),
    ),
    chunk("assets/app-b.js", [], app("features/y.ts")),
  );
  expect(() => run(bundle)).not.toThrow();
});

test("no vendor group captures the TanStack Start runtime or app code", () => {
  const captured = (id: string) =>
    vendorChunkGroups.some((group) => typeof group.test === "function" && group.test(id) === true);
  for (const start of [
    "@tanstack/start-client-core",
    "@tanstack/react-start-client",
    "@tanstack/react-start",
    "@tanstack/start-server-core",
  ])
    expect(captured(lib(start))).toBe(false);
  expect(captured(app("router.tsx"))).toBe(false);
  expect(captured("\0vite/preload-helper.js")).toBe(false);
  // Other TanStack packages are libraries like any other.
  expect(captured(lib("@tanstack/router-core"))).toBe(true);
  expect(captured(lib("react-dom"))).toBe(true);
});
