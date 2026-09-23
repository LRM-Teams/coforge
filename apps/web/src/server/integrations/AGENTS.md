# Integrations

These rules apply to `src/server/integrations/`.

- `GitHubConnection` owns authorization attempts, encrypted user credentials,
  refresh serialization, installation and repository access, on-demand Agent
  owner user credentials, and disconnect. Do not read or refresh GitHub tokens
  elsewhere.
- A GitHub connection never creates a login identity and never confers
  Workspace authority. Callers enforce Workspace scope before using it.
- Only `repositoryOverview` performs full installation verification. The
  project browse reads (`repositoryTree`, `repositoryObject`,
  `repositoryDirectoryCommits`, `repositoryRaw`) rely on the user token's scope
  and must check repository identity in every request.
- The raw OAuth callback route is a thin adapter over this module.
