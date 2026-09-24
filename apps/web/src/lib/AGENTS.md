# Shared library rules

These rules apply to `src/lib/`.

## Dates and times

- Do date arithmetic and time-zone math with `Temporal`, and always name the zone
  (`toZonedDateTimeISO(zone)`, the viewer's preference through `resolveTimeZone`); never rely on
  the host machine's zone. Bun and current Chrome, Edge and Firefox ship `Temporal`; the client
  entry (`src/client.tsx`, `temporal-support.ts`) loads `temporal-polyfill` only where it is
  missing. Use no other Temporal polyfill.
- Compare Temporal values with `.equals()` or `Temporal.X.compare()`, never `===` or `<`.
- Format for people with `Intl` through `dates.ts`; Temporal does not replace it.
- Render time text that depends on "now", the locale or the zone only after `useHydrated()`
  (TanStack Router); before that, emit the instant in `dateTime` only.
