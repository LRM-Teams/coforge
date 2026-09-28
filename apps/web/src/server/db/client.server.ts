import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";

let client: PrismaClient | undefined;
export function getDatabaseClient(): PrismaClient | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  return (client ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  }));
}

export function requireDatabaseClient() {
  const db = getDatabaseClient();
  if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
  return db;
}
