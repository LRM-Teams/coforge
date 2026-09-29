/** Placeholder scan root shown before the user edits a computer's collect paths. */
export function defaultCollectScanPath(platform: string | null | undefined): string {
  return platform === "win32" ? "D:/" : "/home/jian40/\n";
}

/** One editable scan path per row. A single trailing newline is the placeholder, not an extra row. */
export function collectPathLines(value: string): string[] {
  const body = value.endsWith("\n") ? value.slice(0, -1) : value;
  const lines = body.split("\n");
  return lines.length > 0 ? lines : [""];
}

/** Drop one path row. The last remaining row stays, so Backspace cannot clear the field entirely. */
export function removeCollectPathLine(lines: readonly string[], index: number): string[] {
  if (lines.length <= 1 || index < 0 || index >= lines.length) return [...lines];
  return lines.filter((_, lineIndex) => lineIndex !== index);
}
