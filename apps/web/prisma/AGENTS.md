# Prisma schema and migrations

These rules apply to `apps/web/prisma/`. App-wide database rules are in
`apps/web/AGENTS.md`; query rules are in `src/server/db/AGENTS.md`.

- Change `schema.prisma` first, then review the generated SQL migration and
  commit it with the schema change.
- Never use `prisma db push` or `prisma db reset` for shared environments, CI,
  staging, or production. Never mutate the schema on application startup.
