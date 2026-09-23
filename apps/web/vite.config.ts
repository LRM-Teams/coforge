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
    paraglideVitePlugin(paraglideOptions),
    tanstackStart({
      // Default protection only covers `*.server.*` file names; also keep the
      // whole `src/server/` tree and the generated Prisma client out of the
      // client bundle.
      // https://tanstack.com/start/latest/docs/framework/react/guide/import-protection
      importProtection: {
        client: { files: ["**/*.server.*", "**/src/server/**", "**/src/generated/**"] },
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
