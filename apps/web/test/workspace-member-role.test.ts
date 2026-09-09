import { expect, test } from "bun:test";

import { AppError } from "../src/lib/app-error";
import {
  assertCanChangeMemberRole,
  assertCanInvite,
  assertCanLeaveWorkspace,
  assertCanManageMembers,
  assertCanRemoveMember,
  isAdminLike,
  normalizeInvitableRole,
  type WorkspaceMemberRole,
} from "../src/server/workspaces/member-role.server";

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

test("invitations may only target admin or member", () => {
  expect(normalizeInvitableRole("admin")).toBe("admin");
  expect(normalizeInvitableRole("member")).toBe("member");
  expect(() => normalizeInvitableRole("owner")).toThrow(AppError);
  expect(() => normalizeInvitableRole("guest")).toThrow(AppError);
});

test("owner and admin may invite as admin or member", () => {
  expect(() => assertCanInvite("owner", "admin")).not.toThrow();
  expect(() => assertCanInvite("admin", "member")).not.toThrow();
  expect(() => assertCanInvite("member", "member")).toThrow(AppError);
  expect(() => assertCanInvite("owner", "owner")).toThrow(AppError);
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
