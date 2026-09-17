/**
 * Derives a URL-safe slug from a display name: lowercases it, collapses any
 * run of non `[a-z0-9]` characters into a single hyphen, trims leading and
 * trailing hyphens, and cuts the result to `maxLength` without leaving a
 * trailing hyphen from the cut itself.
 */
export function nameToSlug(name: string, maxLength: number): string {
  const collapsed = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return collapsed.slice(0, maxLength).replace(/-+$/, "");
}
