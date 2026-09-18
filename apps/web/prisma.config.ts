import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Schema validation and client generation do not connect to PostgreSQL.
  // Runtime commands must provide DATABASE_URL explicitly.
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://localhost:5432/coforge",
    // Only used by local `migrate diff --from-migrations`; never a runtime dependency.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL ?? process.env.DATABASE_URL,
  },
});
