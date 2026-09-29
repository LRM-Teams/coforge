/**
 * PostgreSQL aborted the transaction for a deadlock (40P01) or a serialization failure (40001),
 * which it asks the client to retry (https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html).
 * Prisma reports it as P2034, or, from a raw query through the driver adapter, as P2010 carrying
 * the adapter's `TransactionWriteConflict`.
 */
export function isWriteConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, meta } = error as { code?: unknown; meta?: unknown };
  if (code === "P2034") return true;
  const cause = (meta as { driverAdapterError?: { cause?: { kind?: unknown } } } | undefined)
    ?.driverAdapterError?.cause;
  return code === "P2010" && cause?.kind === "TransactionWriteConflict";
}

/**
 * Runs `run` up to `attempts` times while it fails on a write conflict; the next attempt usually
 * finds the conflicting writer done. `onRetry` hears each conflict that is retried. Any other
 * failure, and the last conflict, rejects.
 */
export async function retryOnWriteConflict<T>(
  run: () => Promise<T>,
  { attempts, onRetry }: { attempts: number; onRetry: (attempt: number) => void },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !isWriteConflict(error)) throw error;
      onRetry(attempt);
    }
  }
}
