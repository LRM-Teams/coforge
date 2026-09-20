/** Builds a Records deep-link that can return to the overview key-points page. */
export function memberReportKeyPointHref(reportId: string, returnTo: string): string {
  const params = new URLSearchParams({ returnTo });
  return `/records/${reportId}?${params.toString()}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Ensures team key-point markdown attributes sources as clickable `@Name` links
 * to each member report, carrying `returnTo` for the overview page.
 */
export function linkifyKeyPointSourceAttributions(
  markdown: string,
  sources: ReadonlyArray<{ reportId: string; displayName: string }>,
  returnTo: string,
): string {
  if (!markdown.trim() || sources.length === 0) return markdown;
  const sorted = [...sources].sort((left, right) => right.displayName.length - left.displayName.length);
  let result = markdown;
  for (const source of sorted) {
    const name = source.displayName.trim();
    if (!name) continue;
    const href = memberReportKeyPointHref(source.reportId, returnTo);
    const label = `@${name}`;
    const linked = `[${label}](${href})`;
    const nameRe = escapeRegExp(name);
    const reportRe = escapeRegExp(source.reportId);

    // Normalize any existing markdown link that already targets this report.
    result = result.replace(
      new RegExp(`\\[@?${nameRe}\\]\\(/records/${reportRe}(?:\\?[^\\s)]*)?\\)`, "g"),
      linked,
    );

    // Trailing attributions first: （Name） / (Name)
    result = result.replace(new RegExp(`（${nameRe}）`, "g"), `（${linked}）`);
    result = result.replace(new RegExp(`\\(${nameRe}\\)`, "g"), `(${linked})`);

    // `@Name` not already inside a markdown link label (`[@Name](...)`).
    result = result.replace(new RegExp(`(^|[^\\[])@${nameRe}(?![\\w\\]])`, "gm"), `$1${linked}`);
  }
  return result;
}
