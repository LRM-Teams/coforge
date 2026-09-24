# Implementation contract

When implementation starts, use this layout and workflow unless a later
approved decision supersedes it:

```text
apps/web/
├── prisma/
│   ├── schema.prisma
│   └── migrations/
└── src/server/
    └── db/
        ├── client.server.ts
        └── repositories/
```

- `schema.prisma` is the single declarative model for tables owned by
  Web/backend. Generated client output is an implementation artifact and must
  not be hand-edited or imported by browser code.
- `prisma migrate dev` is for a developer's isolated Docker PostgreSQL only;
  `prisma migrate deploy` is the only migration command for shared/staging/
  production databases. `prisma db push` and `prisma db reset` are not part of
  the team workflow.
- The minimum database scripts are `db:validate`, `db:generate`,
  `db:migrate:dev`, `db:migrate:deploy`, and `db:studio`. The exact package
  script wiring is implementation work, but names should remain stable for
  code agents and CI.
- `DATABASE_URL` is injected at runtime. Local Docker PostgreSQL uses a
  developer-only credential and private network; no password, endpoint, or
  production connection string belongs in the repository.
- A migration is complete only when its generated SQL, clean-database apply,
  rollback/forward-compatibility impact, and affected repository tests have
  been reviewed. Destructive or long-running migrations require an explicit
  deployment plan before implementation.
