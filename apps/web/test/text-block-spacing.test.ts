import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Guards the other half of a React Aria `Text`: it renders a `<span>`, so it is inline, and an
 * inline box ignores vertical margin and does not move a line for vertical padding. A description
 * written as `mt-2` therefore looks correct and does nothing — the heading and its body sit
 * touching, which is what a reviewer caught on the Stop Agent dialog after its padding moved to
 * the dialog frame (`#680`, `#681`).
 *
 * `block` is the whole fix, and it is needed on every `Text` that carries its own vertical
 * spacing. This scan is a rule, not a fix: the three it found (the shared `DialogHeader`, the Agent
 * control dialogs, the create-channel dialog) each looked right on their own.
 */
const REPO_ROOT = join(import.meta.dir, "..");
const SOURCE_ROOT = join(REPO_ROOT, "src");

/** A `Text`/`AriaText` opening tag, with everything between the name and its closing bracket. */
const TEXT_TAG = /<(?:Text|AriaText)\b[^>]*>/gs;
const VERTICAL_SPACING = /\b(?:m[ty]|p[ty])-/;
/** Anything that makes the element lay out as a block, so vertical spacing applies. */
const BLOCK_LAYOUT = /\b(?:block|inline-block|flex|grid|table)\b/;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (path.endsWith(".tsx")) files.push(path);
  }
  return files;
}

test("every Text with its own vertical spacing lays out as a block", async () => {
  const offenders: string[] = [];
  for (const path of await sourceFiles(SOURCE_ROOT)) {
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(TEXT_TAG)) {
      const className = /className=(?:"([^"]*)"|\{(?:cx|cn)\(([^)]*)\))/.exec(match[0]);
      const classes = [className?.[1], className?.[2]].filter(Boolean).join(" ");
      if (!VERTICAL_SPACING.test(classes) || BLOCK_LAYOUT.test(classes)) continue;
      offenders.push(
        `${path.slice(REPO_ROOT.length + 1)}: className="${classes.trim()}" needs a block`,
      );
    }
  }
  expect(offenders).toEqual([]);
});
