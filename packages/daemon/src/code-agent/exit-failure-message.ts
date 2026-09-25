/**
 * How every runtime's turn failure is described, in one place: cursor, grok and opencode each kept
 * a byte-identical copy of this nine-line formatter, which is the text that ends up in Activity and
 * in the "did not establish a session identity" error.
 *
 * Raw facts only — the exit code (or the signal), then the stderr tail's non-empty lines. The
 * daemon core redacts and caps runtime error text before it becomes Activity, so this deliberately
 * neither summarizes nor hides anything.
 */
export function exitFailureMessage(result: {
  readonly exitCode: number | null;
  readonly stderrTail: string;
}): string {
  const summary =
    result.exitCode === null ? "terminated by signal" : `exit code ${result.exitCode}`;
  const stderrLines = result.stderrTail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return stderrLines.length ? `${summary} | stderr: ${stderrLines.join(" | ")}` : summary;
}
