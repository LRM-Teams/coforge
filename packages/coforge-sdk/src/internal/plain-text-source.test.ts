import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Guards shipped source against a raw control byte, which git treats as binary.
 *
 * A file with one stops being diffable — `git diff` prints "Binary files … differ" — so a change to
 * it is invisible to review, and linters skip it, which is how a misplaced
 * `oxlint-disable-next-line no-control-regex` survived in `rpc-handler.server.ts`: the file was
 * never linted to notice. A regex that names control bytes spells them `\xNN`; the two deliberate
 * fixtures that need the real bytes live under `test/`, which this does not scan.
 */
const REPO_ROOT = join(import.meta.dir, "../../../..");
const SOURCE_ROOTS: readonly string[] = [
  "apps/web/src",
  "packages/coforge-sdk/src",
  "packages/coforge/src",
  "packages/computer/src",
  "packages/daemon/src",
  "packages/cli/src",
];

/** Bytes no shipped source may hold: all controls except tab, LF, VT, FF, CR, and not DEL. */
function controlBytes(bytes: Uint8Array): number[] {
  return [...bytes].filter((byte) => byte < 9 || (byte > 13 && byte < 32) || byte === 127);
}

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found; // a package that does not exist on this checkout
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

test("no shipped source file holds a raw control byte", async () => {
  const offenders: string[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const path of await sourceFiles(join(REPO_ROOT, root))) {
      const count = controlBytes(await readFile(path)).length;
      if (count > 0) offenders.push(`${relative(REPO_ROOT, path)} (${count})`);
    }
  }
  expect(offenders).toEqual([]);
});
