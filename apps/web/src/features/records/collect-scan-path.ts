/** Placeholder scan root shown before the user edits a computer's collect paths. */
export function defaultCollectScanPath(platform: string | null | undefined): string {
  return platform === "win32" ? "D:/" : "/home/jian40/\n";
}
