# Routes

These rules apply to `src/routes/`.

- `__root.tsx` owns the document shell: HTML, global head, global providers,
  styles, `HeadContent`, and `Scripts`.
- Use pathless layout routes for shared application chrome. `_app.tsx` owns
  `AppShell` and renders `Outlet`.
- Page routes under `_app/` own their page component, loader, `beforeLoad`,
  search validation, head metadata, and pending/error states. Do not pass a
  `page` discriminator into `AppShell` to select page content.
- Keep route files focused on URL ownership and route lifecycle. Put reusable
  business UI and data modules under the owning `src/features/<domain>/`.
- Do not edit the generated `src/routeTree.gen.ts`; regenerate it after
  adding, moving, or deleting route files.
- Do not export route components as additional public symbols. In a
  `.lazy.tsx` route file, use `getRouteApi()` rather than importing `Route`.
- Raw routes under `api/` and OAuth callbacks are thin adapters: parse the
  request, call the owning `src/server/` module, and map its result.
