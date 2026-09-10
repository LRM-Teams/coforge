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
  "@coforge/protocol": fileURLToPath(new URL("../../packages/protocol", import.meta.url)),
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
    paraglideVitePlugin(paraglideOptions),
    tanstackStart(),
    nitro({ preset: "bun" }),
    tailwindcss(),
    viteReact(),
  ],
});

export default config;
