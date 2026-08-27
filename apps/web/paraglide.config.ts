import type { CompilerOptions } from "@inlang/paraglide-js";

export const paraglideOptions = {
  project: "./project.inlang",
  outdir: "./src/paraglide",
  outputStructure: "message-modules",
  cookieName: "PARAGLIDE_LOCALE",
  strategy: ["url", "cookie", "preferredLanguage", "baseLocale"],
  urlPatterns: [
    {
      pattern: "/",
      localized: [
        ["en", "/en"],
        ["zh-CN", "/zh-CN"],
      ],
    },
    {
      pattern: "/:path(.*)?",
      localized: [
        ["en", "/en/:path(.*)?"],
        ["zh-CN", "/zh-CN/:path(.*)?"],
      ],
    },
  ],
} satisfies CompilerOptions;
