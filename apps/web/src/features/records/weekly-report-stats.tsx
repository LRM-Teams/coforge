import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronLeft, ChevronRight } from "@untitledui/icons";

import { PageHeader } from "@/components/layout/page-header";
import { Avatar } from "@/components/base/avatar/avatar";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { m } from "@/paraglide/messages";
import type { loadWeeklyReportStats } from "./records.functions";
import { BackToRecords } from "./records-layout";

export type WeeklyStats = Awaited<ReturnType<typeof loadWeeklyReportStats>>;

export function WeeklyReportStats({
  stats,
  year,
  month,
}: {
  stats: WeeklyStats;
  year: number;
  month: number;
}) {
  const navigate = useNavigate({ from: "/records/stats" });

  function shiftMonth(delta: number) {
    const date = new Date(year, month - 1 + delta, 1);
    void navigate({
      search: (previous) => ({
        tab: previous.tab === "notes" ? "notes" : "weekly",
        year: date.getFullYear(),
        month: date.getMonth() + 1,
      }),
    });
  }

  return (
    <>
      <PageHeader
        heading={m.records_stats()}
        leading={<BackToRecords />}
        actions={
          <div className="flex items-center gap-1">
            <ButtonUtility
              size="sm"
              color="secondary"
              icon={ChevronLeft}
              aria-label={m.records_stats_prev_month()}
              onClick={() => shiftMonth(-1)}
            />
            <span className="min-w-14 text-center text-sm font-medium text-primary tabular-nums">
              {m.records_stats_month({ month })}
            </span>
            <ButtonUtility
              size="sm"
              color="secondary"
              icon={ChevronRight}
              aria-label={m.records_stats_next_month()}
              onClick={() => shiftMonth(1)}
            />
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
        {stats.members.length === 0 ? (
          <p className="py-10 text-center text-sm text-tertiary">{m.records_stats_empty()}</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-secondary shadow-xs">
            <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
              <thead className="bg-secondary text-tertiary">
                <tr>
                  <th className="px-4 py-3 text-xs font-semibold sm:px-5">
                    {m.records_stats_member()}
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold sm:px-5">
                    {m.records_stats_submitted()}
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold sm:px-5">
                    {m.records_stats_unsubmitted()}
                  </th>
                  {stats.weeks.map((week) => (
                    <th key={week} className="px-4 py-3 text-xs font-semibold sm:px-5">
                      {m.records_stats_week({ week })}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-secondary">
                {stats.members.map((member) => (
                  <tr key={member.userId}>
                    <td className="px-4 py-3 sm:px-5">
                      <div className="flex items-center gap-2">
                        <Avatar
                          size="xs"
                          alt={member.displayName}
                          initials={avatarInitial(member.displayName)}
                          contentClassName={avatarToneClassName(member.displayName)}
                        />
                        <span className="font-medium text-primary">{member.displayName}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-tertiary tabular-nums sm:px-5">
                      {member.submitted}
                    </td>
                    <td className="px-4 py-3 text-tertiary tabular-nums sm:px-5">
                      {member.unsubmitted}
                    </td>
                    {stats.weeks.map((week) => {
                      const submitted = member.weeks[week];
                      return (
                        <td key={week} className="px-4 py-3 sm:px-5">
                          {submitted === true ? (
                            <span className="inline-flex size-6 items-center justify-center rounded-full bg-success-secondary text-success-primary">
                              <Check aria-hidden="true" className="size-3.5" />
                            </span>
                          ) : (
                            <span className="text-tertiary">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
