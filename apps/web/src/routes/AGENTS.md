# Routes

These rules apply to `src/routes/`.

- `__root.tsx` owns the document shell: HTML, global head, global providers,
  styles, `HeadContent`, and `Scripts`.
- Every app page lives under `/w/$workspaceSlug` (`w.$workspaceSlug.tsx` owns
  `AppShell` and renders `Outlet`), with Raft's page names: `channel/$channelId`,
  `saved`, `activity`, `tasks`, `search`, `members`, `agent/$agentId`,
  `computers`, `computer/$computerId`, `settings`, plus `projects` and
  `records`; an Agent direct message is `messages/$agentId`. Pathless layouts (`_chat`, `_computers`) share chrome between
  pages without adding a URL segment. Old URLs are not redirected.
- The page URL names the Workspace: server functions act on it
  (`workspaceUserMiddleware`), and a Workspace the User is not in is a 404.
  Build in-app links as typed `to` paths with `params` (`useWorkspaceSlug()`
  in components); where a string is required (an `href` prop, a push URL, a
  server redirect) build it with `workspacePath()`. Never read the
  remembered-Workspace cookie to decide what a page shows.
- A link into another Workspace must not preload (intent preloading runs the
  target's loaders while the browser URL still names the current Workspace);
  the Workspace switcher navigates on select instead of rendering links.
- Page routes under `w.$workspaceSlug/` own their page component, loader,
  `beforeLoad`, search validation, head metadata, and pending/error states. Do
  not pass a `page` discriminator into `AppShell` to select page content.
- Keep route files focused on URL ownership and route lifecycle. Put reusable
  business UI and data modules under the owning `src/features/<domain>/`.
- Do not edit the generated `src/routeTree.gen.ts`; regenerate it after
  adding, moving, or deleting route files.
- Do not export route components as additional public symbols. In a
  `.lazy.tsx` route file, use `getRouteApi()` rather than importing `Route`.
- Raw routes under `api/` and OAuth callbacks are thin adapters: parse the
  request, call the owning `src/server/` module, and map its result.
