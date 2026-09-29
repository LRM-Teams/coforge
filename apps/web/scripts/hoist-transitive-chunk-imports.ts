import type { Plugin } from "vite";

// Start builds each route's `modulepreload` links from `chunk.imports`. Rollup listed a chunk's
// whole static graph there (`hoistTransitiveImports`); Rolldown lists direct imports only and
// does not implement that option (rolldown/rolldown#10820), so chunks two levels down are fetched
// only after their importer has downloaded, in serial waves. Remove this once
// @tanstack/react-start ships the same closure in its manifest builder (TanStack/router#8520).
//
// `chunk.imports` has a second reader: Vite's build-import-analysis derives every dynamic
// import's `__vite__mapDeps` list from it, so widening it for good would grow the entry and
// every error-component stub. The two plugins therefore widen it only for Start:
//
// 1. `widen` (no `enforce`) runs before every `enforce: "post"` plugin and replaces
//    `chunk.imports` with the static closure.
// 2. Start's client-bundle capture (`enforce: "post"`, tanstack-start:start-manifest-capture-
//    client-build in @tanstack/start-plugin-core `vite/start-manifest-plugin/plugin.js`) runs
//    next. `normalizeViteClientChunk` stores `imports: chunk.imports` as that array, without a
//    copy, and nothing reads the bundle again: the manifest is built later, from that stored
//    value (checked in @tanstack/start-plugin-core 1.171.39).
// 3. `restore` (`enforce: "post"`, so it must come after `tanstackStart()` in the plugin list)
//    puts the original arrays back. It assigns them; it does not mutate the widened array Start
//    holds. Vite's own post plugins, including build-import-analysis, then see the direct list.
//
// Order: https://vite.dev/guide/api-plugin#plugin-ordering
export function hoistTransitiveChunkImports(): Plugin[] {
  const directImports = new Map<string, string[]>();
  return [
    {
      name: "hoist-transitive-chunk-imports:widen",
      applyToEnvironment: (environment) => environment.name === "client",
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== "chunk") continue;
          directImports.set(output.fileName, [...output.imports]);
          // A `Set` visits what is added while iterating, so this walks the whole graph.
          const closure = new Set(output.imports);
          for (const fileName of closure) {
            const imported = bundle[fileName];
            if (imported?.type === "chunk") for (const next of imported.imports) closure.add(next);
          }
          output.imports = [...closure];
        }
      },
    },
    {
      name: "hoist-transitive-chunk-imports:restore",
      enforce: "post",
      applyToEnvironment: (environment) => environment.name === "client",
      generateBundle(_options, bundle) {
        // By file name: Rolldown hands each hook its own chunk objects, so the ones `widen` saw
        // are not the ones in this `bundle`, although what `widen` assigned is still there.
        for (const [fileName, imports] of directImports) {
          const output = bundle[fileName];
          if (output?.type === "chunk") output.imports = imports;
        }
        directImports.clear();
      },
    },
  ];
}
