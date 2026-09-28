-- CreateIndex
CREATE INDEX "tasks_ownerMemberId_status_idx" ON "tasks"("ownerMemberId", "status");
