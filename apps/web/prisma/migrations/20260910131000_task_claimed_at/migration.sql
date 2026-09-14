-- Historical claims have no known timestamp; do not fabricate one from updatedAt.
ALTER TABLE "tasks" ADD COLUMN "claimedAt" TIMESTAMP(3);
