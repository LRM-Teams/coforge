-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Workspace" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMembership" (
    "workspaceId" UUID NOT NULL,
    "externalUserId" TEXT NOT NULL,

    CONSTRAINT "WorkspaceMembership_pkey" PRIMARY KEY ("workspaceId","externalUserId")
);

-- CreateTable
CREATE TABLE "Computer" (
    "id" UUID NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,

    CONSTRAINT "Computer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceComputer" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "computerId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceComputer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "WorkspaceMembership_externalUserId_idx" ON "WorkspaceMembership"("externalUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Computer_ownerUserId_machineId_key" ON "Computer"("ownerUserId", "machineId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceComputer_workspaceId_computerId_key" ON "WorkspaceComputer"("workspaceId", "computerId");

-- AddForeignKey
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceComputer" ADD CONSTRAINT "WorkspaceComputer_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceComputer" ADD CONSTRAINT "WorkspaceComputer_computerId_fkey" FOREIGN KEY ("computerId") REFERENCES "Computer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

