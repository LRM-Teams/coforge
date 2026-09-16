CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "githubInstallationId" INTEGER NOT NULL,
    "githubRepositoryId" INTEGER NOT NULL,
    "githubFullName" TEXT NOT NULL,
    "githubHtmlUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "projects_workspaceId_slug_key" ON "projects"("workspaceId", "slug");
CREATE UNIQUE INDEX "projects_workspaceId_githubRepositoryId_key" ON "projects"("workspaceId", "githubRepositoryId");
CREATE INDEX "projects_workspaceId_idx" ON "projects"("workspaceId");
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
