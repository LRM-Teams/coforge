import { createFileRoute } from "@tanstack/react-router";

import { PageLoadError } from "@/features/errors/page-load-error";
import { WeeklyReportSettings } from "@/features/records/weekly-report-settings";
import { loadKeyPointPrompts, loadWeeklyTemplates } from "@/features/records/records.functions";
import type { RecordsTab } from "@/features/records/records-layout";
import { loadWorkspaceMembers } from "@/features/workspaces/members.functions";

export type SettingsSection = "templates" | "key_points";
export type KeyPointSlotSearch = "team" | "personal";

/** Only allow in-app Records return paths (no open redirect). */
export function sanitizeRecordsReturnTo(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("/records/")) return undefined;
  if (value.includes("://") || value.includes("\\") || value.includes("\n")) return undefined;
  if (value.length > 200) return undefined;
  return value;
}

export const Route = createFileRoute("/_app/records/settings")({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    tab: RecordsTab;
    create?: boolean;
    section?: SettingsSection;
    slot?: KeyPointSlotSearch;
    returnTo?: string;
  } => ({
    tab: search.tab === "notes" ? "notes" : "weekly",
    create: search.create === true || search.create === "1" ? true : undefined,
    section: search.section === "key_points" ? "key_points" : undefined,
    slot: search.slot === "team" || search.slot === "personal" ? search.slot : undefined,
    returnTo: sanitizeRecordsReturnTo(search.returnTo),
  }),
  loader: async () => {
    const [templates, members, keyPointPrompts] = await Promise.all([
      loadWeeklyTemplates(),
      loadWorkspaceMembers(),
      loadKeyPointPrompts(),
    ]);
    return { templates, members: members.members, keyPointPrompts };
  },
  errorComponent: PageLoadError,
  component: WeeklyReportSettingsPage,
});

function WeeklyReportSettingsPage() {
  const data = Route.useLoaderData();
  const { create, section, slot, returnTo } = Route.useSearch();
  return (
    <WeeklyReportSettings
      templates={data.templates}
      members={data.members}
      keyPointPrompts={data.keyPointPrompts}
      openCreateOnMount={create === true}
      initialSection={section}
      initialSlot={slot}
      returnTo={returnTo}
    />
  );
}
