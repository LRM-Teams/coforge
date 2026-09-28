/**
 * Whether a caught `error` carries a runtime error code and it is `code` — `ENOENT`, `SQLITE_BUSY`,
 * Prisma's `P2002`, and friends.
 *
 * Deliberately a shape check rather than `instanceof Error`. The callers span a Prisma error, a
 * filesystem error and a `bun:sqlite` error, and their tests pass doubles that carry only the code —
 * which is the property `unique-violation.server.ts` already documents. The `typeof` / `"code" in`
 * dance is what makes that work, and three copies of it lived in Web, the computer package and the
 * daemon.
 *
 * Two neighbours are deliberately left alone, because they ask something stricter:
 * `packages/agent/src/runner.ts` requires an `instanceof Error` that carries the code (an
 * Error-less object with `code: "ENOENT"` must not count there), and
 * `platform/diagnostic-error-code.ts` reads the code out for logging rather than comparing it.
 */
export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
