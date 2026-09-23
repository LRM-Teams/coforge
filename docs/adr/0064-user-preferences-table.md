# ADR 0064: Per-user settings live in a 1:1 `user_preferences` table

Status: accepted
Date: 2026-09-23

## Context

Personal settings were columns on `users`: `timeZone`, `browserNotificationsEnabled`
and `conversationOpenMode`. The Language & region page adds a time format, and
more settings are planned (message font size, translation, and similar). Each one
would widen the identity row, and two of the three stored an explicit default
(`false`, `'first-unread'`), so changing a default later needed a data rewrite.
`conversationOpenMode` was validated only in application code.

## Decision

- Settings move to `user_preferences`, one row per user: `userId` is the primary
  key and a foreign key to `users` with `ON DELETE CASCADE`. `createdAt`/`updatedAt`
  record changes. The row is created on the first saved setting (upsert).
- One typed column per setting. Every column is nullable: NULL means "not
  chosen", and the default lives in `UserPreferences` code.
- A closed set is `TEXT` plus a `CHECK` constraint added in the migration.
  Prisma cannot express CHECK, so the migration is customized
  ([Prisma: unsupported database features](https://www.prisma.io/docs/orm/prisma-migrate/workflows/unsupported-database-features)).
  Postgres enums are not used because "existing values cannot be removed from an
  enum type" ([PostgreSQL: enumerated types](https://www.postgresql.org/docs/current/datatype-enum.html)).
- Adding a setting is an `ADD COLUMN … NULL`, which does not rewrite the table.
- `UserPreferences` (`server/db/repositories/user-preferences.repositories.server.ts`)
  stays the only reader and writer, except relational filters that must join the
  table (web-push recipients filter on `preferences.browserNotificationsEnabled`).

Per-device settings (theme, text size, sidebar labels) stay in browser storage.

## Alternatives

- **Keep adding columns to `users`.** No migration of existing data, but the
  identity row keeps growing and defaults stay frozen in stored values.
- **One JSONB column.** No migration per setting, but no per-key constraints,
  an untyped `JsonValue` in Prisma, whole-document rewrites on each save, and
  awkward relational filters.
- **Key–value rows (`userId`, `key`, `value`).** Untyped strings, no constraints,
  and hard to query.

## Migration

`20260923015113_user_preferences_table` creates the table, copies only values a
user changed (a set time zone, notifications on, a non-default open mode), and
drops the three `users` columns. Rolling back requires a reverse migration that
re-adds the columns and copies the rows back with the old defaults.

The migration is a single destructive step, not expand/contract: while the
`migrate` service has run and the old web image is still serving, and after a
web-image-only rollback, queries that read the dropped `users` columns fail
(Settings loads and web-push fan-out) until the new image is serving. This is
accepted during MVP; roll forward rather than rolling back the image alone.
