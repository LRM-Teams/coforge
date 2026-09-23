import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { resolveGitHubCommitTrailers } from "@/server/integrations/github-commit-trailers.server";

const botEnv = {
  COFORGE_GITHUB_APP_SLUG: "coforge-staging",
  COFORGE_GITHUB_APP_BOT_USER_ID: "328977087",
};
const expectedTrailer =
  "Co-authored-by: coforge-staging[bot] <328977087+coforge-staging[bot]@users.noreply.github.com>";

test("commit trailers follow the bound Project's toggle, default on otherwise, and need a configured bot", async () => {
  const connectionString = Bun.env.GITHUB_COMMIT_TRAILERS_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("GITHUB_COMMIT_TRAILERS_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const workspace = await db.workspace.create({
    data: { slug: `trailers-${suffix}`, name: "Trailers" },
  });
  const otherWorkspace = await db.workspace.create({
    data: { slug: `trailers-other-${suffix}`, name: "Trailers other" },
  });
  try {
    const boundOn = await db.project.create({
      data: {
        workspaceId: workspace.id,
        slug: "bound-on",
        name: "Bound on",
        githubFullName: "acme/bound-on",
      },
    });
    const boundOff = await db.project.create({
      data: {
        workspaceId: workspace.id,
        slug: "bound-off",
        name: "Bound off",
        githubFullName: "acme/bound-off",
        commitCoAuthor: false,
      },
    });
    // Same repository bound in a different Workspace must never leak its toggle across Workspaces.
    await db.project.create({
      data: {
        workspaceId: otherWorkspace.id,
        slug: "bound-off-elsewhere",
        name: "Bound off elsewhere",
        githubFullName: "acme/unbound",
        commitCoAuthor: false,
      },
    });

    expect(await resolveGitHubCommitTrailers(db, workspace.id, "acme/bound-on", botEnv)).toEqual([
      expectedTrailer,
    ]);
    // Case-insensitive match against the stored `githubFullName`.
    expect(await resolveGitHubCommitTrailers(db, workspace.id, "ACME/Bound-On", botEnv)).toEqual([
      expectedTrailer,
    ]);
    expect(await resolveGitHubCommitTrailers(db, workspace.id, "acme/bound-off", botEnv)).toEqual(
      [],
    );
    expect(await resolveGitHubCommitTrailers(db, workspace.id, "acme/unbound", botEnv)).toEqual([
      expectedTrailer,
    ]);
    expect(await resolveGitHubCommitTrailers(db, workspace.id, null, botEnv)).toEqual([
      expectedTrailer,
    ]);
    expect(await resolveGitHubCommitTrailers(db, workspace.id, "acme/bound-on", {})).toEqual([]);
    expect(await resolveGitHubCommitTrailers(db, workspace.id, null, {})).toEqual([]);

    void boundOn;
    void boundOff;
  } finally {
    await db.project.deleteMany({
      where: { workspaceId: { in: [workspace.id, otherWorkspace.id] } },
    });
    await db.workspace.deleteMany({ where: { id: { in: [workspace.id, otherWorkspace.id] } } });
    await db.$disconnect();
  }
});
