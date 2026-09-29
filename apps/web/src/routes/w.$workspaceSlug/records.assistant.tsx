import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { PageHeader } from "#src/components/layout/page-header";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { RecordSidePanel } from "#src/features/records/record-side-panel";
import { BackToRecords } from "#src/features/records/records-layout";
import { loadLatestEditableMemberReport } from "#src/features/records/records.functions";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";

export const Route = createFileRoute("/w/$workspaceSlug/records/assistant")({
  loader: () => loadLatestEditableMemberReport(),
  errorComponent: PageLoadError,
  component: WeeklyReportAssistantPage,
});

function WeeklyReportAssistantPage() {
  const report = Route.useLoaderData();
  const navigate = useNavigate();
  const workspaceSlug = useWorkspaceSlug();
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-primary">
      <PageHeader heading={m.records_assistant_page_title()} leading={<BackToRecords />} />
      {report ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <h2 className="text-lg font-semibold text-primary">{report.title}</h2>
          <p className="max-w-lg text-sm text-tertiary">{m.records_assistant_page_hint()}</p>
          <RecordSidePanel
            subjectType="report"
            subjectId={report.id}
            surface="plain"
            open
            onOpenChange={(open) => {
              if (!open)
                void navigate({
                  to: "/w/$workspaceSlug/records",
                  params: { workspaceSlug },
                  search: { tab: "weekly" },
                });
            }}
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-tertiary">
          {m.records_assistant_page_empty()}
        </div>
      )}
    </div>
  );
}
