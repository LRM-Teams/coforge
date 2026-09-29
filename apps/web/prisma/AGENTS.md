# Prisma schema and migrations

These rules apply to `apps/web/prisma/`. App-wide database rules are in
`apps/web/AGENTS.md`; query rules are in `src/server/db/AGENTS.md`.

- Change `schema.prisma` first, then review the generated SQL migration and
  commit it with the schema change.
- Never use `prisma db push` or `prisma db reset` for shared environments, CI,
  staging, or production. Never mutate the schema on application startup.
- Declare every partial index in `schema.prisma` (`@@index`/`@@unique` with
  `where:`, the `partialIndexes` preview feature). One that exists only in
  migration SQL is drift: `prisma migrate diff` generates a `DROP INDEX` for it.
- A new `migrations/*/migration.sql` ends with exactly one newline, like any
  other changed file (`apps/web/AGENTS.md`). Delete the blank line only:
  `prisma migrate diff` compares statements, not whitespace (#1111, #1191).
