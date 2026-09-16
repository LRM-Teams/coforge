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

/** Localized weekday name for an ISO weekday (1 = Monday). */
export function weekdayLabel(day: number) {
  switch (day) {
    case 1:
      return m.records_template_weekday_mon();
    case 2:
      return m.records_template_weekday_tue();
    case 3:
      return m.records_template_weekday_wed();
    case 4:
      return m.records_template_weekday_thu();
    case 5:
      return m.records_template_weekday_fri();
    case 6:
      return m.records_template_weekday_sat();
    default:
      return m.records_template_weekday_sun();
  }
}
