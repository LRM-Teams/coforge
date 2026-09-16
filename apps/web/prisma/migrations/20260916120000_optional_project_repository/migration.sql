ALTER TABLE "projects"
  ALTER COLUMN "githubInstallationId" DROP NOT NULL,
  ALTER COLUMN "githubRepositoryId" DROP NOT NULL,
  ALTER COLUMN "githubFullName" DROP NOT NULL,
  ALTER COLUMN "githubHtmlUrl" DROP NOT NULL;
