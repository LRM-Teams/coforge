import {
  Outlet,
  createFileRoute,
  useMatchRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";

import { PageLoadError } from "@/features/errors/page-load-error";
import { RecordsLayout, type RecordsTab } from "@/features/records/records-layout";
import { loadRecordsCatalog } from "@/features/records/records.functions";
import { latestWeeklyLanding } from "@/features/records/records-sidebar";

export const Route = createFileRoute("/_app/records")({
  validateSearch: (search: Record<string, unknown>): { tab: RecordsTab } => ({
    tab: search.tab === "notes" ? "notes" : "weekly",
  }),
  loader: () => loadRecordsCatalog(),
  errorComponent: PageLoadError,
  component: RecordsPage,
});

function RecordsPage() {
  const catalog = Route.useLoaderData();
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const params = useParams({
    from: "/_app/records/$recordId",
    shouldThrow: false,
  });
  const weekParams = useParams({
    from: "/_app/records/weeks/$year/$week",
    shouldThrow: false,
  });
  const matchRoute = useMatchRoute();
  const selectedPanel = matchRoute({ to: "/records/settings", fuzzy: false })
    ? "settings"
    : matchRoute({ to: "/records/stats", fuzzy: false })
      ? "stats"
      : null;
  const routeRecordId = params?.recordId;
  const selectedWeekKey = weekParams ? `${weekParams.year}-${weekParams.week}` : undefined;
  const landing =
    tab === "weekly" && !selectedPanel && !routeRecordId && !selectedWeekKey
      ? latestWeeklyLanding({
          memberWeeks: catalog.memberWeeks,
        })
      : undefined;
  const landingReportId = landing?.kind === "report" ? landing.id : undefined;

  return (
    <RecordsLayout
      catalog={catalog}
      selectedRecordId={routeRecordId ?? landingReportId}
      selectedWeekKey={selectedWeekKey}
      detailOpen={Boolean(routeRecordId || selectedPanel || selectedWeekKey)}
      selectedPanel={selectedPanel}
      tab={tab}
      onTabChange={(next) => {
        void navigate({
          search: { tab: next },
          replace: true,
        });
      }}
    >
      <Outlet />
    </RecordsLayout>
  );
}
