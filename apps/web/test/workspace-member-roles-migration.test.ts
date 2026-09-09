import { expect, test } from "bun:test";

const migration = await Bun.file(
  new URL(
    "../prisma/migrations/20260909000000_workspace_member_roles/migration.sql",
    import.meta.url,
  ),
).text();

test("workspace member roles migration adds role check and pending invitation uniqueness", () => {
  expect(migration).toContain("CHECK (\"role\" IN ('owner', 'admin', 'member'))");
  expect(migration).toContain("CHECK (\"role\" IN ('admin', 'member'))");
  expect(migration).toContain(
    'CREATE UNIQUE INDEX "workspace_invitations_pending_workspace_invitee_key"',
  );
  expect(migration).toContain("WHERE \"status\" = 'pending'");
});
