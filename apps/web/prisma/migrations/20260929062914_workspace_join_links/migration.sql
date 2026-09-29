-- CreateTable
CREATE TABLE "workspace_join_links" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "maxUses" INTEGER,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_join_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_join_links_token_key" ON "workspace_join_links"("token");

-- CreateIndex
CREATE INDEX "workspace_join_links_workspaceId_idx" ON "workspace_join_links"("workspaceId");

-- AddForeignKey
ALTER TABLE "workspace_join_links" ADD CONSTRAINT "workspace_join_links_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_join_links" ADD CONSTRAINT "workspace_join_links_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
