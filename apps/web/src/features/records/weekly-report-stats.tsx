import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronLeft, ChevronRight } from "@untitledui/icons";

import { PageHeader } from "@/components/layout/page-header";
import { Avatar } from "@/components/base/avatar/avatar";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
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
          <div className="flex items-center gap-1 rounded-lg border border-secondary px-1">
            <ButtonUtility
              icon={ChevronLeft}
              size="sm"
              color="tertiary"
              aria-label={m.records_stats_prev_month()}
              onClick={() => shiftMonth(-1)}
            />
            <span className="min-w-14 text-center text-sm font-medium">
              {m.records_stats_month({ month })}
            </span>
            <ButtonUtility
              icon={ChevronRight}
              size="sm"
              color="tertiary"
              aria-label={m.records_stats_next_month()}
              onClick={() => shiftMonth(1)}
            />
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
        {stats.members.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {m.records_stats_empty()}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
              <thead className="bg-muted/60 text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-semibold">{m.records_stats_member()}</th>
                  <th className="px-4 py-3 font-semibold">{m.records_stats_submitted()}</th>
                  <th className="px-4 py-3 font-semibold">{m.records_stats_unsubmitted()}</th>
                  {stats.weeks.map((week) => (
                    <th key={week} className="px-4 py-3 font-semibold">
                      {m.records_stats_week({ week })}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.members.map((member) => (
                  <tr key={member.userId} className="border-t">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Avatar
                          size="sm"
                          alt={member.displayName}
                          initials={avatarInitial(member.displayName)}
                          contentClassName={avatarToneClassName(member.displayName)}
                        />
                        <span className="font-medium">{member.displayName}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{member.submitted}</td>
                    <td className="px-4 py-3 text-muted-foreground">{member.unsubmitted}</td>
                    {stats.weeks.map((week) => {
                      const submitted = member.weeks[week];
                      return (
                        <td key={week} className="px-4 py-3">
                          {submitted === true ? (
                            <span className="inline-flex size-6 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600">
                              <Check aria-hidden="true" className="size-3.5" />
                            </span>
                          ) : submitted === false ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
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
