import { defineConfig } from "vite";

import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";

import { paraglideOptions } from "./paraglide.config.ts";

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  server: {
    allowedHosts: [".onamp.dev"],
    host: "127.0.0.1",
    port: 8788,
    strictPort: true,
  },
  plugins: [
    paraglideVitePlugin(paraglideOptions),
    tanstackStart(),
    nitro({ preset: "bun" }),
    tailwindcss(),
    viteReact(),
  ],
});

export default config;
