import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RPC_METHODS, LEGACY_RPC_METHOD_NAMES } from "./rpc-methods";

/**
 * Guards the one-owner rule for the internal RPC method vocabulary: every wire method name lives
 * in `RPC_METHODS` (`./rpc-methods.ts`) once, and nothing outside that module may hard-code one as
 * a string literal. Consumer code must import the per-feature `*_METHOD` constant (or `RPC_METHODS`)
 * instead, so a rename touches one place and reviewers can trust a single source of truth. The
 * pre-rename spellings (`LEGACY_RPC_METHOD_NAMES`) are part of the same vocabulary and live there
 * too, so the upgrade window cannot scatter across call sites.
 */
const SCANNED_METHODS = [...Object.values(RPC_METHODS), ...Object.values(LEGACY_RPC_METHOD_NAMES)];

const REPO_ROOT = join(import.meta.dir, "../../../..");

/** Every package's `src` directory, plus the web app's. */
async function scanRoots(): Promise<string[]> {
  const packagesDirectory = join(REPO_ROOT, "packages");
  const entries = await readdir(packagesDirectory, { withFileTypes: true });
  const packageSrcDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join("packages", entry.name, "src"));
  return [...packageSrcDirs, "apps/web/src"];
}

/** The only file allowed to hold a method-name literal, and why. */
const ALLOWLIST: Readonly<Record<string, string>> = {
  "packages/coforge-sdk/src/internal/rpc-methods.ts": "the RPC method-name vocabulary itself",
};

const LITERAL_PATTERN = new RegExp(
  SCANNED_METHODS.map((value) => `["']${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).join(
    "|",
  ),
);

function isScannableSource(path: string): boolean {
  return (
    (path.endsWith(".ts") || path.endsWith(".tsx")) &&
    !path.endsWith(".test.ts") &&
    !path.endsWith(".test.tsx") &&
    !path.endsWith(".gen.ts") &&
    !path.endsWith(".gen.tsx") &&
    !path.includes("/gen/") &&
    !path.includes("/generated/")
  );
}

async function collectSourceFiles(root: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await collectSourceFiles(path)));
    else if (entry.isFile() && isScannableSource(path)) files.push(path);
  }
  return files;
}

test("only the vocabulary module hard-codes an internal RPC method name", async () => {
  const violations: string[] = [];
  for (const root of await scanRoots()) {
    const files = await collectSourceFiles(join(REPO_ROOT, root));
    for (const file of files) {
      const relativePath = file.slice(REPO_ROOT.length + 1);
      if (relativePath in ALLOWLIST) continue;
      const content = await readFile(file, "utf8");
      if (LITERAL_PATTERN.test(content)) violations.push(relativePath);
    }
  }
  expect(
    violations,
    "Found an internal RPC method name hard-coded as a string literal outside " +
      `rpc-methods.ts: ${violations.join(", ")}. Import the matching *_METHOD constant (or ` +
      "RPC_METHODS) from @lrm/coforge-sdk/internal instead, or add the file to that test's " +
      "ALLOWLIST with a reason if the literal genuinely names something else.",
  ).toEqual([]);
});
