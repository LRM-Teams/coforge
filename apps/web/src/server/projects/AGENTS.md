# Project server modules

These rules apply to `src/server/projects/`.

- Enforce Workspace scope before calling `GitHubConnection` for any repository
  read. Project Server Functions do it for detail and browse reads;
  `ProjectFiles` does it for the download route
  `/api/projects/$projectId/raw/$`, which stays a thin adapter.
- Project settings are authorized by Workspace membership. Deletion requires
  the user to confirm the project name.
- Deleting a Project preserves its discussion groups, their memberships, and
  their messages by clearing the Project relation.
- Creating a Project never creates a discussion group. Discussion groups are
  created on demand through `PublicChannels.create(..., projectId)` and use the
  ordinary channel route; do not add a project-specific channel path.
- A Project may be created from a public github.com URL without a GitHub
  Connection. Private repositories and later repository changes still require
  the caller's GitHub access.
- Project icons live in the public image store (`getPublicImageStorage`), not
  the private files store: uploading, replacing, reading, and deleting a
  Project all reach the icon there, after authorization. The GET icon route
  only serves authorized image bytes.
  Validate uploads with the shared `server/files/image-upload.server.ts`.
