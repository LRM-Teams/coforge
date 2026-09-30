import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import settings from "../project.inlang/settings.json";

const webRoot = join(import.meta.dir, "..");

// A plugin loaded from a URL is fetched at build time. On a host that cannot reach it Paraglide
// only warns and emits an empty message index, so every `m.x()` in the production bundle becomes
// `(void 0)()` and the app will not load. Local plugins resolve against the directory holding
// `project.inlang/`.
test("every inlang plugin loads from an installed package, not the network", () => {
  expect(settings.modules.length).toBeGreaterThan(0);
  for (const module of settings.modules) {
    expect(module).toStartWith("./node_modules/");
    expect(existsSync(join(webRoot, module))).toBe(true);
  }
});
