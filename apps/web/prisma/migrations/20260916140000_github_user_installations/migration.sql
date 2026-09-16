-- CreateTable
CREATE TABLE "github_user_installations" (
    "userId" UUID NOT NULL,
    "installationId" INTEGER NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "repositorySelection" TEXT NOT NULL,
    "suspended" BOOLEAN NOT NULL,
    "configureUrl" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_user_installations_pkey" PRIMARY KEY ("userId","installationId")
);

-- CreateIndex
CREATE INDEX "github_user_installations_installationId_idx" ON "github_user_installations"("installationId");

-- AddForeignKey
ALTER TABLE "github_user_installations" ADD CONSTRAINT "github_user_installations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
