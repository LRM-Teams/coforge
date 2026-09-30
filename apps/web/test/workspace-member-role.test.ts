import { expect, test } from "bun:test";

import { AppError } from "#src/lib/app-error";
import {
  assertCanCreateAgents,
  assertCanChangeMemberRole,
  assertCanAssignRole,
  assertCanLeaveWorkspace,
  assertCanManageMembers,
  assertCanRemoveMember,
  isAdminLike,
  normalizeAssignableRole,
  type WorkspaceMemberRole,
} from "#src/server/workspaces/member-role.server";

test("owner and admin are admin-like; member is not", () => {
  expect(isAdminLike("owner")).toBe(true);
  expect(isAdminLike("admin")).toBe(true);
  expect(isAdminLike("member")).toBe(false);
});

test("only owner and admin may manage members", () => {
  expect(() => assertCanManageMembers("owner")).not.toThrow();
  expect(() => assertCanManageMembers("admin")).not.toThrow();
  expect(() => assertCanManageMembers("member")).toThrow(AppError);
});

test("an assigned role may only be admin or member", () => {
  expect(normalizeAssignableRole("admin")).toBe("admin");
  expect(normalizeAssignableRole("member")).toBe("member");
  expect(() => normalizeAssignableRole("owner")).toThrow(AppError);
  expect(() => normalizeAssignableRole("guest")).toThrow(AppError);
});

test("owner and admin may assign admin or member", () => {
  expect(() => assertCanAssignRole("owner", "admin")).not.toThrow();
  expect(() => assertCanAssignRole("admin", "member")).not.toThrow();
  expect(() => assertCanAssignRole("member", "member")).toThrow(AppError);
  expect(() => assertCanAssignRole("owner", "owner")).toThrow(AppError);
});

test("workspace ownership cannot be changed", () => {
  const cases: Array<{
    actor: WorkspaceMemberRole;
    target: WorkspaceMemberRole;
    next: WorkspaceMemberRole;
  }> = [
    { actor: "owner", target: "owner", next: "admin" },
    { actor: "owner", target: "admin", next: "owner" },
    { actor: "admin", target: "member", next: "owner" },
  ];
  for (const { actor, target, next } of cases) {
    expect(() => assertCanChangeMemberRole(actor, target, next)).toThrow(AppError);
  }
});

test("admin may promote and demote between admin and member", () => {
  expect(() => assertCanChangeMemberRole("admin", "member", "admin")).not.toThrow();
  expect(() => assertCanChangeMemberRole("admin", "admin", "member")).not.toThrow();
  expect(() => assertCanChangeMemberRole("owner", "admin", "member")).not.toThrow();
});

test("member cannot change roles", () => {
  expect(() => assertCanChangeMemberRole("member", "member", "admin")).toThrow(AppError);
});

test("owner cannot be removed; admin and member can", () => {
  expect(() => assertCanRemoveMember("owner", "owner")).toThrow(AppError);
  expect(() => assertCanRemoveMember("admin", "owner")).toThrow(AppError);
  expect(() => assertCanRemoveMember("owner", "admin")).not.toThrow();
  expect(() => assertCanRemoveMember("admin", "member")).not.toThrow();
  expect(() => assertCanRemoveMember("member", "member")).toThrow(AppError);
});

test("owner cannot leave; admin and member can", () => {
  expect(() => assertCanLeaveWorkspace("owner")).toThrow(AppError);
  expect(() => assertCanLeaveWorkspace("admin")).not.toThrow();
  expect(() => assertCanLeaveWorkspace("member")).not.toThrow();
});

test("only owner and admin may create Agents", () => {
  expect(() => assertCanCreateAgents("owner")).not.toThrow();
  expect(() => assertCanCreateAgents("admin")).not.toThrow();
  expect(() => assertCanCreateAgents("member")).toThrow(AppError);
});

// `assertCanRemoveChannelMembers` (the original owner/admin-only gate) is removed:
// `PublicChannels.removeMember`'s capability-based `remove_member` check supersedes it
// (`resolveChannelAuthority`, covered by `channel-authority.test.ts` and
// `public-channel.integration.ts`), which is a strict superset — every actor the old gate allowed
// still passes (`server_role` basis), plus a channel admin via stored `channelRole` now also
// qualifies.
