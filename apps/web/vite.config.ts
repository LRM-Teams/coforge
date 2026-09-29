import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";

import { paraglideOptions } from "./paraglide.config.ts";

// Workspace packages resolve through bun's symlinked node_modules, which
// rolldown's native resolver fails to follow in some Linux environments
// (musl, overlayfs). Alias them explicitly.
const workspaceAliases = {
  "@lrm/coforge-sdk/internal": fileURLToPath(
    new URL("../../packages/coforge-sdk", import.meta.url),
  ),
};

const config = defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: workspaceAliases,
  },
  // Bun builtins (`import … from "bun"`) are not npm packages. Without this,
  // Vite's client dependency scan fails when it crawls server modules that use
  // RedisClient / other Bun APIs, and skips pre-bundling after lockfile changes.
  optimizeDeps: {
    exclude: ["bun"],
    // TipTap stack is opened from Records; pre-bundle so the first report open
    // does not stall on dependency discovery (kept eager on purpose).
    include: [
      "@tiptap/react",
      "@tiptap/starter-kit",
      "@tiptap/markdown",
      "@tiptap/extension-placeholder",
      "@tiptap/extension-table",
      "@tiptap/extension-link",
      "@tiptap/extension-image",
      "@tiptap/extension-task-list",
      "@tiptap/extension-task-item",
      "@tiptap/extension-highlight",
      "@tiptap/extension-typography",
      "katex",
      "lowlight",
    ],
  },
  ssr: {
    external: ["bun"],
  },
  server: {
    allowedHosts: [".onamp.dev"],
    host: "127.0.0.1",
    port: 8788,
    strictPort: true,
    proxy: {
      "/connection": "ws://127.0.0.1:8000",
    },
  },
  environments: {
    // Client build only: nitro's server build inlines its dynamic imports.
    client: {
      build: {
        rolldownOptions: {
          output: {
            codeSplitting: {
              groups: [
                // Rolldown makes a chunk for every icon that two lazy chunks share: about
                // thirty files of 0.3-1 KB on a chat page. Icons are leaf modules without
                // side effects, so one chunk for the shared ones is safe. Do not add a group
                // for app modules: merging them across sharing sets drags Records-only code
                // into chat and reorders execution between chunks (a trial failed at load
                // with `e is not a constructor`).
                // https://rolldown.rs/in-depth/manual-code-splitting
                {
                  name: "icons",
                  test: /node_modules[\\/]@untitledui[\\/]icons[\\/]/,
                  minShareCount: 2,
                },
              ],
            },
          },
        },
      },
    },
  },
  plugins: [
    {
      name: "externalize-bun-builtin",
      enforce: "pre",
      resolveId(id) {
        if (id === "bun" || id.startsWith("bun:")) {
          return { id, external: true };
        }
      },
    },
    {
      // Nitro's Vite dev middleware treats any request whose Sec-Fetch-Dest is not
      // "empty"/"document" as a static asset and 404s when no file exists, so an <img>
      // pointing at /api/attachments/* never reaches the app in local dev. Production
      // Nitro has no such branch. Present API subresource requests as plain fetches.
      name: "coforge-api-subresources",
      apply: "serve",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          if (request.url?.startsWith("/api/") && request.headers["sec-fetch-dest"])
            request.headers["sec-fetch-dest"] = "empty";
          next();
        });
      },
    },
    {
      // Start builds each route's `modulepreload` links from `chunk.imports`. Rollup listed a
      // chunk's whole static graph there (`hoistTransitiveImports`); Rolldown lists direct
      // imports only and does not implement that option (rolldown/rolldown#10820), so chunks two
      // levels down are fetched only after their importer has downloaded, in serial waves.
      // Widen `imports` to the static closure before Start's client-bundle capture reads it
      // (it runs at `enforce: "post"`). Remove once @tanstack/react-start ships the same change
      // in its manifest builder (TanStack/router#8520, #8511).
      name: "hoist-transitive-chunk-imports",
      applyToEnvironment: (environment) => environment.name === "client",
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== "chunk") continue;
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
    paraglideVitePlugin(paraglideOptions),
    tanstackStart({
      // Default protection only covers `*.server.*` file names; also keep the
      // whole `src/server/` tree and the generated Prisma client out of the
      // client bundle.
      // https://tanstack.com/start/latest/docs/framework/react/guide/import-protection
      importProtection: {
        client: { files: ["**/*.server.*", "**/src/server/**", "**/src/generated/**"] },
      },
      router: {
        codeSplittingOptions: {
          // `pendingComponent` is critical by default, so a route file that imports its
          // skeleton from the feature's view module pulls that whole view into the entry
          // chunk of every page. Split it like `component`; the router loads both before
          // it needs either (`loadComponents` in @tanstack/router-core).
          // https://tanstack.com/router/latest/docs/guide/automatic-code-splitting
          defaultBehavior: [
            ["component"],
            ["pendingComponent"],
            ["errorComponent"],
            ["notFoundComponent"],
          ],
        },
      },
    }),
    nitro({
      preset: "bun",
      // Avoid cyclic SSR chunks evaluating server functions before createSsrRpc
      // initializes. Keep client splitting; only the final server bundle is inlined.
      // https://github.com/TanStack/router/issues/8031
      inlineDynamicImports: true,
    }),
    tailwindcss(),
    viteReact(),
  ],
});

export default config;
