-- Workspace human roles (owner | admin | member) and invitations.

ALTER TABLE "workspace_memberships"
ADD COLUMN "role" TEXT NOT NULL DEFAULT 'member',
ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "workspace_memberships"
ADD CONSTRAINT "workspace_memberships_role_check"
CHECK ("role" IN ('owner', 'admin', 'member'));

-- Existing Workspaces: prefer the member whose username matches the workspace slug;
-- otherwise promote the lexicographically first userId as the immutable owner.
UPDATE "workspace_memberships" AS membership
SET "role" = 'owner'
FROM (
  SELECT DISTINCT ON (m."workspaceId")
    m."workspaceId",
    m."userId"
  FROM "workspace_memberships" AS m
  INNER JOIN "workspaces" AS w ON w."id" = m."workspaceId"
  INNER JOIN "users" AS u ON u."id" = m."userId"
  ORDER BY
    m."workspaceId",
    CASE WHEN u."username" = w."slug" THEN 0 ELSE 1 END,
    m."userId"
) AS chosen
WHERE membership."workspaceId" = chosen."workspaceId"
  AND membership."userId" = chosen."userId";

CREATE TABLE "workspace_invitations" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "inviterUserId" UUID NOT NULL,
    "inviteeUserId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_invitations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workspace_invitations_role_check"
      CHECK ("role" IN ('admin', 'member')),
    CONSTRAINT "workspace_invitations_status_check"
      CHECK ("status" IN ('pending', 'accepted', 'revoked', 'expired'))
);

CREATE INDEX "workspace_invitations_workspaceId_status_idx"
ON "workspace_invitations"("workspaceId", "status");

CREATE INDEX "workspace_invitations_inviteeUserId_status_idx"
ON "workspace_invitations"("inviteeUserId", "status");

-- Only one live pending invitation per invitee inside a Workspace.
CREATE UNIQUE INDEX "workspace_invitations_pending_workspace_invitee_key"
ON "workspace_invitations"("workspaceId", "inviteeUserId")
WHERE "status" = 'pending';

ALTER TABLE "workspace_invitations"
ADD CONSTRAINT "workspace_invitations_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workspace_invitations"
ADD CONSTRAINT "workspace_invitations_inviterUserId_fkey"
FOREIGN KEY ("inviterUserId") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workspace_invitations"
ADD CONSTRAINT "workspace_invitations_inviteeUserId_fkey"
FOREIGN KEY ("inviteeUserId") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
