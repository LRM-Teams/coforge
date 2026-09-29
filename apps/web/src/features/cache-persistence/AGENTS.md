# Browser copy of the Query cache

These rules apply to `src/features/cache-persistence/`. It is Slack's client-store boot: the Query
cache (our client store) is copied into IndexedDB, and the next page load shows Chat from that copy
while the normal reads and realtime bring it up to date
([Slack](https://slack.engineering/getting-to-slack-faster-with-incremental-boot/)). It uses
TanStack Query's per-query persister, `experimental_createQueryPersister`, not
`PersistQueryClientProvider`
([docs](https://tanstack.com/query/latest/docs/framework/react/plugins/createPersister)): each query
is its own row, written when its read succeeds, restored the first time it is fetched, and
independent of the in-memory cache's garbage collection and of `queryClient.clear()` (a Workspace
switch clears memory, not storage). Pin the package version; read its changelog before upgrading,
because the API is experimental.

- `persisted-queries.ts` decides what is kept, and nothing else does. It is an allow-list: a query
  is added only after checking that its data holds nothing volatile or secret (Agent Activity,
  status and presence, an Agent's environment, tokens, upload sessions), that its key names the
  Workspace or conversation it belongs to (a key without one would let another Workspace show
  through), and that its data survives structured cloning. Add a test that names the real query key
  (`query-cache-persistence.test.ts`, "the queries the app really defines").
- What is kept is the first paint, not the whole query: a conversation keeps its newest page and
  only when that page is the live end; the Saved list keeps its newest 100; a DM list that fell
  back per call is not kept. Apply the same cut to a new kind, so a restore never opens a page at
  a place nobody meant to open it.
- Nothing is read or written until the person is known (`viewerId`: the Workspace layout loader's
  `user.id`, read from the router's state in `router.tsx`). Every key starts with that person's id,
  the first use by a person removes every other person's rows, and a store that fails is a miss,
  never a failed read.
- Every way to `/auth/logout` goes through `signOut()` (`features/auth/sign-out.ts`), which removes
  every row and seals the page against writing more before it navigates. Do not link to
  `/auth/logout` directly.
- A restored query is marked invalidated, and that is what makes the read follow it: any page that
  shows it reads it again (whatever `staleTime` says: the Chat lists use `Infinity`), and the Chat
  loader's "marked stale" reads it. Do not set the persister's `refetchOnRestore`: it is a bare
  `query.fetch()` that a page unmounting meanwhile cancels for good.
- A query the server answers `NOT_FOUND` (deleted, or access lost) is removed from storage.
- `maxAge` is 7 days and a sweep removes older rows at most once a day. The buster is the build
  (`__COFORGE_BUILD_ID__`, defined in `vite.config.ts`; `COFORGE_BUILD_ID` overrides it), so a
  deploy never opens a page from the previous build's query shapes.
- Browser only. `installBrowserQueryCachePersistence` does nothing where there is no IndexedDB, so
  the server render's per-request QueryClient never sees a persister. Do not put persistence
  options in the QueryClient's `dehydrate` defaults: the SSR integration reads those too.
- `networkMode` stays `online`; a persister would otherwise make every query `offlineFirst`.
- The browser test is `test/e2e-query-cache-persistence.e2e.ts` (opt-in, like the other `*.e2e.ts`:
  local Web at `COFORGE_E2E_WEB_URL` and `agent-browser`; its proxy holds the Chat reads).
