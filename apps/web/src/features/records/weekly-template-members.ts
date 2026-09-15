import { m } from "@/paraglide/messages";

export type TemplateMemberOption = {
  userId: string;
  username: string;
  displayName: string | null;
  role?: string;
};

export function memberLabel(member: {
  displayName?: string | null;
  username?: string;
  role?: string;
}) {
  const name = member.displayName || member.username || "";
  const role =
    member.role === "owner"
      ? m.workspace_role_owner()
      : member.role === "admin"
        ? m.workspace_role_admin()
        : member.role === "member"
          ? m.workspace_role_member()
          : member.role;
  return role ? `${name} - ${role}` : name;
}
