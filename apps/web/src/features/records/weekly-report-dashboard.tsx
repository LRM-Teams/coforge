import { Link } from "@tanstack/react-router";
import { ArrowUpRight, CheckCircle, Users01 as Users } from "@untitledui/icons";

import { PageHeader } from "#src/components/layout/page-header";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import type { loadWeeklyReportDashboard } from "./records.functions";
import { BackToRecords } from "./records-layout";

type Dashboard = Awaited<ReturnType<typeof loadWeeklyReportDashboard>>;

export function WeeklyReportDashboard({ dashboard }: { dashboard: Dashboard }) {
  const workspaceSlug = useWorkspaceSlug();
  const latest = dashboard.weeks[0];
  return (
    <>
      <PageHeader heading={m.records_dashboard()} leading={<BackToRecords />} />
      <div className="min-h-0 flex-1 overflow-auto bg-primary px-4 py-5 sm:px-6">
        <div className="mx-auto w-full max-w-6xl space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-primary">{m.records_dashboard_title()}</h2>
            <p className="mt-1 text-sm text-tertiary">{m.records_dashboard_hint()}</p>
          </div>
          {dashboard.weeks.length === 0 ? (
            <p className="rounded-xl border border-secondary p-8 text-center text-sm text-tertiary">
              {m.records_dashboard_empty()}
            </p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Metric
                  label={m.records_dashboard_weeks()}
                  value={String(dashboard.weeks.length)}
                />
                <Metric
                  label={m.records_dashboard_members()}
                  value={String(dashboard.members.length)}
                />
                <Metric
                  label={m.records_dashboard_latest_submitted()}
                  value={`${latest.submitted}/${latest.total}`}
                />
              </div>
              <div className="space-y-4">
                {dashboard.members.map((member) => (
                  <section
                    key={member.userId}
                    className="rounded-xl border border-secondary bg-primary"
                  >
                    <div className="flex items-center gap-2 border-b border-secondary px-4 py-3">
                      <Users aria-hidden="true" className="size-4 text-tertiary" />
                      <h3 className="font-semibold text-primary">{member.displayName}</h3>
                    </div>
                    <div className="grid gap-3 p-4 md:grid-cols-3">
                      {dashboard.weeks.map((week) => {
                        const report = week.reports.find((item) => item.authorId === member.userId);
                        return (
                          <div
                            key={`${member.userId}-${week.year}-${week.week}`}
                            className="rounded-lg bg-secondary p-3"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-semibold text-tertiary">
                                {week.year} W{week.week}
                              </span>
                              {report ? (
                                <CheckCircle
                                  aria-hidden="true"
                                  className="size-4 text-success-primary"
                                />
                              ) : null}
                            </div>
                            <p className="mt-2 min-h-10 text-sm text-primary">
                              {report?.summary || m.records_dashboard_not_submitted()}
                            </p>
                            {report ? (
                              <Link
                                to="/w/$workspaceSlug/records/$recordId"
                                params={{ workspaceSlug, recordId: report.id }}
                                search={{ tab: "weekly" }}
                                className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-brand-secondary hover:underline"
                              >
                                {m.records_dashboard_open_report()}
                                <ArrowUpRight aria-hidden="true" className="size-3" />
                              </Link>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-secondary bg-primary p-4">
      <p className="text-xs text-tertiary">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-primary tabular-nums">{value}</p>
    </div>
  );
}
