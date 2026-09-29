# Prisma schema and migrations

These rules apply to `apps/web/prisma/`. App-wide database rules are in
`apps/web/AGENTS.md`; query rules are in `src/server/db/AGENTS.md`.

- Change `schema.prisma` first, then review the generated SQL migration and
  commit it with the schema change.
- Never use `prisma db push` or `prisma db reset` for shared environments, CI,
  staging, or production. Never mutate the schema on application startup.
- A new `migrations/*/migration.sql` ends with exactly one newline — no second,
  blank line at the end of the file. CI's `Plan checks` job runs
  `git diff --check`, which fails the whole run on a trailing blank line, and
  no package `check` reads this file, so the local checks stay green while the
  run goes red (#1111, #1191). Delete the blank line only: `prisma migrate diff`
  compares statements, not whitespace. Reproduce what CI sees before pushing
  with `git diff --check origin/main...HEAD`.
