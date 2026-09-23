import type { PrismaClient } from "@/generated/prisma/client";
import { readGitHubAppBotIdentity } from "./github-config.server";

/**
 * Decides the `Co-authored-by` trailer(s) an Agent's commit to `repository` should carry (empty
 * means none). The CLI (`coforge git prepare-commit-msg`) never builds this itself - see
 * `apps/web/src/routes/api/agent/v1/github-commit-trailers.ts`.
 *
 * - A `repository` bound to a Project in this Workspace follows that Project's `commitCoAuthor`
 *   toggle (default on).
 * - Any other repository, or no repository at all (`repository === null`, e.g. no `origin` or a
 *   non-github.com remote), defaults on: there is no Project setting to turn it off.
 * - Either way, an unconfigured bot identity (`COFORGE_GITHUB_APP_BOT_USER_ID` unset - see
 *   `readGitHubAppBotIdentity`) always answers no trailers.
 */
export async function resolveGitHubCommitTrailers(
  db: PrismaClient,
  workspaceId: string,
  repository: string | null,
  env: Record<string, string | undefined> = Bun.env,
): Promise<string[]> {
  if (repository) {
    const project = await db.project.findFirst({
      where: { workspaceId, githubFullName: { equals: repository, mode: "insensitive" } },
      select: { commitCoAuthor: true },
    });
    if (project && !project.commitCoAuthor) return [];
  }
  const bot = readGitHubAppBotIdentity(env);
  if (!bot) return [];
  return [
    `Co-authored-by: ${bot.slug}[bot] <${bot.botUserId}+${bot.slug}[bot]@users.noreply.github.com>`,
  ];
}
