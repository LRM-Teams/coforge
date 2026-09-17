import { useState } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "@/components/base/buttons/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { useAppToast } from "@/components/ui/toast";
import { BackToRecords, WeekBadge } from "@/features/records/records-layout";
import { generateWeeklyHighlights } from "@/features/records/records.functions";
import { m } from "@/paraglide/messages";

export function WeekHighlightEmpty(props: {
  year: number;
  week: number;
  title: string;
  overviewReportId: string;
  canGenerate: boolean;
}) {
  const navigate = useNavigate();
  const router = useRouter();
  const toast = useAppToast();
  const generate = useServerFn(generateWeeklyHighlights);
  const [busy, setBusy] = useState(false);

  async function onGenerate() {
    if (!props.canGenerate || busy) return;
    setBusy(true);
    try {
      const result = await generate({
        data: { reportId: props.overviewReportId, memberIds: "all" },
      });
      await router.invalidate();
      await navigate({
        to: "/records/$recordId",
        params: { recordId: result.highlightId },
        search: { tab: "weekly" },
      });
    } catch (error) {
      toast.error(m.records_week_highlight_generate_failed(), error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-secondary px-4 py-3">
        <BackToRecords />
        <WeekBadge week={props.week} />
        <h1 className="min-w-0 truncate text-base font-semibold text-primary">{props.title}</h1>
      </div>
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>{m.records_week_highlight_empty_title()}</EmptyTitle>
          <EmptyDescription>{m.records_week_highlight_empty_description()}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            size="md"
            isDisabled={!props.canGenerate || busy}
            isLoading={busy}
            onClick={() => void onGenerate()}
            aria-label={
              props.canGenerate
                ? m.records_week_highlight_generate()
                : m.records_week_highlight_generate_disabled()
            }
          >
            {m.records_week_highlight_generate()}
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}
