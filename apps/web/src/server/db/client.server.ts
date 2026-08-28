import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../../generated/client";

let client: PrismaClient | undefined;
export function getDatabaseClient(): PrismaClient | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  return (client ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }));
}
