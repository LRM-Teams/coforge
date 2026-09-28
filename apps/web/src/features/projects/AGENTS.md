# Projects UI

These rules apply to `src/features/projects/`.

- AppShell exposes one Projects navigation item on desktop and mobile.
  Project creation belongs on the Projects page, not in either sidebar.
- The file browser loads the repository tree once per visit and keys file
  content by blob oid, which never goes stale. Do not refetch the tree per
  directory or re-read content already cached for an oid.
- Downloads use the authorized `/api/projects/$projectId/raw/$` route; GitHub
  and download URLs are built in `project-file-urls.ts`.
