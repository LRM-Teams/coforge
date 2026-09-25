/**
 * Escaping for the XML this daemon hands to the OS: launchd plists and Windows Scheduled Task
 * definitions.
 *
 * Four writers each kept a private `xml()` with the same four entities in it —
 * `daemon-host/launchd.ts`, `daemon-host/windows-task.ts`, `platform/computer-upgrade-launcher.ts`
 * and `platform/launchd-job.ts`, nineteen call sites between them — which is why the rule has one
 * home now.
 *
 * The fourth copy did two things the others did not: it escaped `'` as well, and it refused XML
 * 1.0's forbidden control characters (including NUL) instead of writing them into a file the OS
 * would go on to reject. That difference is deliberately not resolved here — whether the other
 * three should refuse too is a decision about failure modes, not a rename — so both rules have a
 * name and a caller, and the divergence is visible in one place instead of four.
 */

/** The four entities every XML writer here escapes. */
export function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** What the launchd job writer escapes into a plist value: the same four entities, plus `'`, and a
 * refusal of the control characters XML 1.0 disallows. */
export function escapePlistValue(value: string): string {
  // XML 1.0 disallows these control characters, including NUL.
  // oxlint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error("invalid plist value");
  return escapeXmlText(value).replaceAll("'", "&apos;");
}
