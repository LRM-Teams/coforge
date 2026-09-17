const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SSH = /^git@github\.com:([^/]+)\/([^/]+)$/;

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "");
}

/**
 * Reads a GitHub repository identity from the New Project field: `owner/repo`,
 * an HTTPS github.com URL, or an SSH github.com remote. Other hosts stay
 * unrecognized because a Project can only store a GitHub App repository.
 */
export function parseGitHubRepositoryInput(value: string): { fullName: string } | null {
  const trimmed = stripGitSuffix(value.trim());
  if (!trimmed) return null;
  if (OWNER_REPO.test(trimmed)) return { fullName: trimmed };

  const ssh = trimmed.match(SSH);
  if (ssh && OWNER_REPO.test(`${ssh[1]}/${ssh[2]}`)) return { fullName: `${ssh[1]}/${ssh[2]}` };

  try {
    const url = new URL(trimmed);
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
    const [owner, repo] = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (!owner || !repo) return null;
    const fullName = `${owner}/${stripGitSuffix(repo)}`;
    return OWNER_REPO.test(fullName) ? { fullName } : null;
  } catch {
    return null;
  }
}
