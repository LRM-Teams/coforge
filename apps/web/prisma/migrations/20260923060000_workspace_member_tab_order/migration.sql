-- A member's own settings inside one Workspace: the conversation and Agent profile panel tab orders.
-- An empty array means the default order; the first tab in the order opens by default.
CREATE TABLE "workspace_member_preferences" (
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "conversationTabOrder" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agentProfileTabOrder" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_member_preferences_pkey" PRIMARY KEY ("workspaceId","userId"),
    CONSTRAINT "workspace_member_preferences_conversationTabOrder_check"
      CHECK ("conversationTabOrder" <@ ARRAY['chat', 'tasks', 'files']::TEXT[]),
    CONSTRAINT "workspace_member_preferences_agentProfileTabOrder_check"
      CHECK ("agentProfileTabOrder" <@ ARRAY['profile', 'reminders', 'activity', 'workspace']::TEXT[])
);

-- AddForeignKey
ALTER TABLE "workspace_member_preferences" ADD CONSTRAINT "workspace_member_preferences_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "workspace_memberships"("workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
