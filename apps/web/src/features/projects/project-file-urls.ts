const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Same-origin download of one repository file (`/api/projects/$projectId/raw/$`). */
export function projectFileDownloadUrl(projectId: string, path: string) {
  return `/api/projects/${projectId}/raw/${encodePath(path)}`;
}

export function githubUrl(fullName: string, branch: string, path: string, kind: "tree" | "blob") {
  const base = `https://github.com/${fullName}`;
  if (path === "") return base;
  return `${base}/${kind}/${encodeURIComponent(branch)}/${encodePath(path)}`;
}
