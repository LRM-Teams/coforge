import { AsyncLocalStorage } from "node:async_hooks";

/**
 * W3C Server Timing (https://www.w3.org/TR/server-timing/) for SSR documents and Server Function
 * calls, so DevTools and `PerformanceResourceTiming.serverTiming` show where server time went.
 *
 * The header names only two fixed metrics, `total` and `db`, each with a `dur` in milliseconds:
 * nothing from the request, the route, or the user. It is still infrastructure detail every
 * visitor could read, so it is off unless the deployment sets `COFORGE_SERVER_TIMING=1`.
 */
type QueryInterval = [startedAt: number, endedAt: number];
const requestQueries = new AsyncLocalStorage<QueryInterval[]>();

export function isServerTimingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COFORGE_SERVER_TIMING === "1";
}

/**
 * Records one database query, as `performance.now()` instants, against the request that issued
 * it. A query outside a request (a background sweep) is dropped.
 */
export function recordDatabaseQuery(startedAt: number, endedAt: number): void {
  requestQueries.getStore()?.push([startedAt, endedAt]);
}

/**
 * Runs a request handler and appends `Server-Timing: total;dur=…, db;dur=…` to its response.
 * `total` ends when the response headers exist, so for a streamed SSR document it covers the
 * loaders and the first render, not the rest of the stream. `db` is the part of that time with at
 * least one query in flight (overlapping queries count once), so it never exceeds `total`. Router
 * responses other than HTML (server routes under `/api`) are left alone.
 */
export async function withServerTiming<T extends { response: Response }>(
  handlerType: "serverFn" | "router",
  next: () => Promise<T> | T,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  if (!isServerTimingEnabled(env)) return next();

  const queries: QueryInterval[] = [];
  const startedAt = performance.now();
  const result = await requestQueries.run(queries, next);
  const totalMs = performance.now() - startedAt;

  const { headers } = result.response;
  if (handlerType === "router" && !headers.get("content-type")?.startsWith("text/html"))
    return result;
  headers.append(
    "Server-Timing",
    `total;dur=${milliseconds(totalMs)}, db;dur=${milliseconds(timeInFlight(queries))}`,
  );
  return result;
}

function timeInFlight(queries: QueryInterval[]): number {
  let busy = 0;
  let coveredUntil = -Infinity;
  for (const [start, end] of queries.sort((a, b) => a[0] - b[0])) {
    busy += Math.max(0, end - Math.max(start, coveredUntil));
    coveredUntil = Math.max(coveredUntil, end);
  }
  return busy;
}

function milliseconds(value: number): string {
  return String(Math.round(value * 10) / 10);
}
