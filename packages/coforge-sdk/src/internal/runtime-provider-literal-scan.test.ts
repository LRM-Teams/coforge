import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNTIME_PROVIDER } from "./index";

/**
 * Guards the one-owner rule for the RuntimeProvider vocabulary: nothing outside
 * `RUNTIME_PROVIDER` (and this file's short allowlist) may hard-code one of its values as a
 * string literal. A provider value is scanned only when it is unambiguous as a provider —
 * "coforge" and "pi" also appear constantly as the product name and as unrelated English/math
 * text, so they are excluded to keep this test free of false positives.
 */
const SCANNED_PROVIDER_VALUES = Object.values(RUNTIME_PROVIDER).filter(
  (value) => value !== RUNTIME_PROVIDER.COFORGE && value !== RUNTIME_PROVIDER.PI,
);

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

/** Every file allowed to hard-code a scanned provider value, and why. */
const ALLOWLIST: Readonly<Record<string, string>> = {
  "packages/coforge-sdk/src/internal/index.ts": "the RuntimeProvider vocabulary module itself",
  "packages/daemon/src/code-agent/runtime-inventory.ts":
    'the provider-to-executable table; Codex\'s CLI binary is literally named "codex"',
  "packages/daemon/src/code-agent/codex/provider.ts":
    'a logger category and the Codex CLI executable/subcommand ("codex", "app-server")',
  "packages/daemon/src/code-agent/codex/usage.ts":
    'the Codex CLI executable/subcommand ("codex", "app-server")',
  "packages/daemon/src/code-agent/kiro/catalog.ts": "a logger category",
  "packages/daemon/src/code-agent/cursor/catalog.ts": "a logger category",
  "packages/daemon/src/code-agent/cursor/turn-process.ts": "a logger category",
};

const LITERAL_PATTERN = new RegExp(
  SCANNED_PROVIDER_VALUES.map((value) => `["']${value}["']`).join("|"),
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

test("only the allowlisted files hard-code a RuntimeProvider string literal", async () => {
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
    "Found a RuntimeProvider value hard-coded as a string literal outside the allowlist in " +
      `runtime-provider-literal-scan.test.ts: ${violations.join(", ")}. ` +
      "Use RUNTIME_PROVIDER / parseRuntimeProvider (or a display label table keyed by " +
      "RuntimeProvider) instead of the raw string, or add the file to that test's ALLOWLIST " +
      "with a reason if the literal genuinely names something else (an executable, a logger " +
      "category).",
  ).toEqual([]);
});
