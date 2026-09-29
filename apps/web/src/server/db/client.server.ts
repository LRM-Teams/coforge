import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  isServerTimingEnabled,
  recordDatabaseQuery,
} from "#src/server/observability/server-timing.server";

let client: PrismaClient | undefined;
export function getDatabaseClient(): PrismaClient | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  return (client ??= createDatabaseClient(url));
}

function createDatabaseClient(url: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: url });
  // Query events make Prisma format every query's parameters, so they are on only while the
  // deployment asks for Server-Timing.
  if (!isServerTimingEnabled()) return new PrismaClient({ adapter });
  const timed = new PrismaClient({ adapter, log: [{ emit: "event", level: "query" }] });
  // Prisma emits the event when the query finishes, in the async context of its caller.
  timed.$on("query", (event) => {
    const endedAt = performance.now();
    recordDatabaseQuery(endedAt - event.duration, endedAt);
  });
  return timed;
}

export function requireDatabaseClient() {
  const db = getDatabaseClient();
  if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
  return db;
}
