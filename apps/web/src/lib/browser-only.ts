/**
 * Fails when what it guards is reached while the server renders. TanStack DB collections are
 * browser-only (`features/conversations/AGENTS.md`): one created during a server render would
 * never sync, and would only be dropped with that request's `QueryClient`. Vite replaces
 * `import.meta.env.SSR` at build time, true only in the server's bundle, so the check is gone from
 * the browser's.
 * https://vite.dev/guide/ssr#conditional-logic
 */
export function assertBrowserOnly(what: string): void {
  if (import.meta.env.SSR) throw new Error(`${what} is browser-only and was reached on the server`);
}
