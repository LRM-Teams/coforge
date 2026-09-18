import { defineConfig } from "prisma/config";

export function prismaDatasource(env: NodeJS.ProcessEnv) {
  const shadowDatabaseUrl = env.SHADOW_DATABASE_URL?.trim();
  return {
    url: env.DATABASE_URL ?? "postgresql://localhost:5432/coforge",
    // A shadow database is only for local `migrate diff --from-migrations`. Omitting it lets
    // `migrate deploy` use only the main database; falling back to DATABASE_URL makes Prisma
    // reject production deployment because the shadow and main database are identical.
    ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
  };
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Schema validation and client generation do not connect to PostgreSQL.
  // Runtime commands must provide DATABASE_URL explicitly.
  datasource: prismaDatasource(process.env),
});
