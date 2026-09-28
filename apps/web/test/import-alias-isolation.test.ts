import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The web tsconfig maps `#src/*` to apps/web/src, and TypeScript applies that
// mapping to package source compiled into the web program before it consults
// the package's own `imports`. A package `#src/x` that also names a web file
// would therefore type-check against the wrong module while Bun and Vite run
// the right one. Keep the two spaces disjoint.
const repoRoot = join(import.meta.dir, "..", "..", "..");
const webSrc = join(repoRoot, "apps", "web", "src");
const specifier = /["']#src\/([^"']+)["']/g;

function packageAliasSpecifiers(): Map<string, string> {
  const found = new Map<string, string>();
  const glob = new Bun.Glob("packages/*/{src,test}/**/*.ts");
  for (const file of glob.scanSync({ cwd: repoRoot })) {
    for (const match of readFileSync(join(repoRoot, file), "utf8").matchAll(specifier)) {
      found.set(match[1], file);
    }
  }
  return found;
}

test("no package #src/ import names a module that also exists in apps/web/src", () => {
  const collisions = [...packageAliasSpecifiers()]
    .filter(([path]) =>
      [".ts", ".tsx", ".js", "/index.ts", "/index.tsx"].some((suffix) =>
        existsSync(join(webSrc, path + suffix)),
      ),
    )
    .map(([path, file]) => `${file}: #src/${path}`);
  expect(collisions).toEqual([]);
});

test("the package scan sees the packages' #src/ imports", () => {
  expect(packageAliasSpecifiers().size).toBeGreaterThan(100);
});
