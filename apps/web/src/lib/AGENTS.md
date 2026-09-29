# Shared library rules

These rules apply to `src/lib/`; the date and time rules apply to all of `apps/web`.

## Dates and times

- Do date arithmetic and time-zone math with `Temporal`, and always name the zone
  (`toZonedDateTimeISO(zone)`, the viewer's preference through `resolveTimeZone`); never rely on
  the host machine's zone. Bun and current Chrome, Edge and Firefox ship `Temporal`; the client
  entry (`src/client.tsx`, `temporal-support.ts`) loads `temporal-polyfill` only where it is
  missing. Use no other Temporal polyfill.
- Compare Temporal values with `.equals()` or `Temporal.X.compare()`, never `===` or `<`.
- Format for people with `Intl` through `dates.ts`; Temporal does not replace it.
- Render time text that depends on "now" (relative times) only after `useHydrated()` (TanStack
  Router); before that, emit the instant in `dateTime` only. Text that depends on the locale and
  the zone alone (a message's clock and day) renders on the server in the zone `useTimeZone()`
  gives: the saved preference, else the browser's, which the browser writes in the
  `coforge-time-zone` cookie. Server and hydrating render then agree; the zone is unknown only on
  a browser's first visit, and the text stays unformatted until it reports.
