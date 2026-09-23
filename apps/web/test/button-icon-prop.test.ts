import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Guards the house `Button` API against the one mistake that looks like a layout bug rather than a
 * code one: passing an icon as a child instead of through `iconLeading`/`iconTrailing`.
 *
 * `Button` renders every child inside its single `data-text` span. An untitled-ui icon is an `svg`
 * with `width`/`height` attributes that the preflight stylesheet makes block-level, so inside that
 * inline span it takes a line of its own and the label drops below it — a two-line button
 * (the Stop Agent dialog, #118) whose classNames all look correct. The prop renders the icon before
 * the span instead, with the `data-icon` size/shrink rules applied.
 */
const REPO_ROOT = join(import.meta.dir, "..");
const SOURCE_ROOT = join(REPO_ROOT, "src");

/** `<Button …>` whose first child is an icon element, which is the shape to avoid. */
const ICON_CHILD = /<Button\b[^>]*>\s*<([A-Z][A-Za-z0-9]*)\s[^>]*aria-hidden/g;
/** The icon-prop spelling of the same thing, which is fine wherever it appears. */
const ICON_PROP = /\bicon(?:Leading|Trailing)=/;

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

test("no Button passes its icon as a child instead of iconLeading/iconTrailing", async () => {
  const offenders: string[] = [];
  for (const path of await sourceFiles(SOURCE_ROOT)) {
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(ICON_CHILD)) {
      if (ICON_PROP.test(match[0])) continue;
      offenders.push(`${path.slice(REPO_ROOT.length + 1)}: <Button> child <${match[1]}>`);
    }
  }
  expect(offenders).toEqual([]);
});
