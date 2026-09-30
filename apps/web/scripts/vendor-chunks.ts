import type { Plugin, Rolldown } from "vite";

// Library code (`node_modules`) is cut into `vendor*` chunks apart from app code, so a deploy that
// changes only app code leaves those chunks' hashes alone and browsers keep them. Rolldown's own
// guide for this: https://rolldown.rs/in-depth/manual-code-splitting ("Reduce cache invalidation").
//
// Every group sets `includeDependenciesRecursively: false`. The default, `true`, follows a
// captured module's imports "without considering constraints", which drags app modules along:
// TanStack Start's `hydrateStart` imports the app's `router.tsx` and `start.ts`, and the trial
// build moved the whole route tree and app entry into the react-dom chunk. With `false`, the
// vendor chunks hold only what the group's `test` accepts.
// https://rolldown.rs/reference/TypeAlias.CodeSplittingGroup#includedependenciesrecursively
//
// Which modules a chunk holds, in the order Rolldown applies the groups (same `priority`: the
// lower index wins):
//
// 1. `vendor-react`, `vendor-tanstack`, `vendor-react-aria`: library code the entry statically
//    reaches (`tags: ["$initial"]`), one chunk per family, so a release of one family does not
//    rehash the others (TanStack and React Aria release often, React rarely).
// 2. `vendor-initial`: the rest of what the entry reaches. Every page loads it anyway, so one
//    chunk costs nothing over several, and it saves the long tail of small chunks that
//    `entriesAware` makes (`entriesAware` alone took a chat page from 152 files to 180).
// 3. `vendor`: library code behind lazy chunks, `entriesAware: true`, one chunk per set of lazy
//    chunks that import it: "each entry only loads the code it actually uses", so mermaid,
//    cytoscape, katex and the content editor stay with the pages that use them.
//    `entriesAwareMergeThreshold` would merge small sets into a neighbour and pulled mermaid
//    into the Members page; `minSize` sends small modules back to automatic chunking, where a
//    vendor chunk then imports an app chunk. Neither is used.
// https://rolldown.rs/reference/TypeAlias.CodeSplittingGroup#entriesaware

// TanStack Start's runtime imports the app (`#tanstack-router-entry`, `#tanstack-start-entry`
// resolve to `src/router.tsx` and `src/start.ts`), so a chunk holding it imports an app chunk and
// the app chunk imports it back. It stays with the app.
const isStartRuntime = (id: string) =>
  /node_modules[\\/]@tanstack[\\/](?:react-start|start-)/.test(id);

const isLibrary = (id: string) => id.includes("node_modules") && !isStartRuntime(id);

const inFamily = (family: RegExp) => (id: string) => isLibrary(id) && family.test(id);

export const vendorChunkGroups: Rolldown.CodeSplittingGroup[] = [
  {
    name: "vendor-react",
    test: inFamily(/node_modules[\\/](?:react|react-dom|scheduler|use-sync-external-store)[\\/]/),
    tags: ["$initial"],
    priority: 30,
    includeDependenciesRecursively: false,
  },
  {
    name: "vendor-tanstack",
    test: inFamily(/node_modules[\\/]@tanstack[\\/]/),
    tags: ["$initial"],
    priority: 30,
    includeDependenciesRecursively: false,
  },
  {
    name: "vendor-react-aria",
    test: inFamily(
      /node_modules[\\/](?:react-aria|react-aria-components|react-stately|@react-aria|@react-stately|@react-types|@internationalized)[\\/]/,
    ),
    tags: ["$initial"],
    priority: 30,
    includeDependenciesRecursively: false,
  },
  {
    name: "vendor-initial",
    test: isLibrary,
    tags: ["$initial"],
    priority: 20,
    includeDependenciesRecursively: false,
  },
  {
    name: "vendor",
    test: isLibrary,
    entriesAware: true,
    priority: 10,
    includeDependenciesRecursively: false,
  },
];

// The invariant the groups above are built to keep, checked on the real bundle: a chunk made only
// of `node_modules` code never imports a chunk that holds app code. Otherwise its hash follows
// the app's, and if that app chunk imports it back the two form a cycle, which Rolldown's guide
// warns can fail at load.
// Virtual modules (`\0vite/preload-helper.js`, `\0rolldown/runtime.js`) are not app code. A chunk
// that holds both, such as the entry with Start's runtime, counts as an app chunk.
export function assertLibraryChunksDoNotImportAppChunks(): Plugin {
  const isAppModule = (id: string) => !id.includes("node_modules") && !id.startsWith("\0");
  return {
    name: "assert-library-chunks-do-not-import-app-chunks",
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle(_options, bundle) {
      const appChunks = new Set<string>();
      for (const output of Object.values(bundle))
        if (output.type === "chunk" && Object.keys(output.modules).some(isAppModule))
          appChunks.add(output.fileName);
      const violations: string[] = [];
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk" || appChunks.has(output.fileName)) continue;
        for (const imported of output.imports)
          if (appChunks.has(imported)) violations.push(`${output.fileName} imports ${imported}`);
      }
      if (violations.length)
        this.error(
          `A chunk made only of node_modules code imports a chunk that holds app code, which ` +
            `rehashes the library chunk on every app change and can form an import cycle. Keep ` +
            `the package that imports the app out of the vendor groups (scripts/vendor-chunks.ts):\n  ` +
            violations.join("\n  "),
        );
    },
  };
}
