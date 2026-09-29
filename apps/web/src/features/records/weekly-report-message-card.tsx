import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { Button } from "#src/components/base/buttons/button";
import type { OpenAgentProfile } from "#src/features/agents/profile-panel/open-agent-profile";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import type { WeeklyReportAssistantSuggestion } from "#src/server/records/weekly-report-assistant-suggestion.server";
import { applyConfirmedWeeklyReportBody } from "./records.functions";
import { WeeklyReportCollectPlanCard } from "./weekly-report-collect-plan-card";
import { WeeklyReportCollectRunCard } from "./weekly-report-collect-run-card";
import {
  readCollectCardRunId,
  writeCollectCardRunId,
  readAppliedSuggestionIds,
  writeAppliedSuggestionIds,
} from "./weekly-report-assistant-session";

export type WeeklyReportMessageSuggestion = Extract<
  WeeklyReportAssistantSuggestion,
  { type: "collect-plan" | "body-edit" }
>;

export function WeeklyReportMessageCard(props: {
  messageId: string;
  suggestion: WeeklyReportMessageSuggestion;
  onOpenAgentProfile?: OpenAgentProfile;
  disabled?: boolean;
}) {
  const { suggestion } = props;
  const workspaceSlug = useWorkspaceSlug();
  const cardKey = `${workspaceSlug}:${props.messageId}`;
  const applyBody = useServerFn(applyConfirmedWeeklyReportBody);
  const [runId, setRunId] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setRunId(readCollectCardRunId(cardKey));
    setApplied(readAppliedSuggestionIds(cardKey).includes(props.messageId));
    setLoaded(true);
  }, [cardKey, props.messageId]);

  function onSubmitted(id: string) {
    writeCollectCardRunId(cardKey, id);
    setRunId(id);
  }

  async function insertDraft() {
    if (suggestion.type !== "body-edit" || busy || applied || props.disabled) return;
    setBusy(true);
    setError(null);
    try {
      await applyBody({ data: { reportId: suggestion.reportId, content: suggestion.content } });
      setApplied(true);
      writeAppliedSuggestionIds(cardKey, [props.messageId]);
    } catch {
      setError(m.records_assistant_write_failed());
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <p className="text-sm text-tertiary">{m.records_collect_run_loading()}</p>;

  return (
    <div className="mt-3 space-y-3">
      {suggestion.type === "collect-plan" ? (
        runId ? (
          <WeeklyReportCollectRunCard runId={runId} />
        ) : (
          <WeeklyReportCollectPlanCard
            storageKey={props.messageId}
            reportId={suggestion.reportId}
            year={suggestion.year}
            week={suggestion.week}
            disabled={props.disabled}
            onOpenAgentProfile={props.onOpenAgentProfile}
            onSubmitted={onSubmitted}
          />
        )
      ) : (
        <>
          <p className="whitespace-pre-wrap text-sm text-secondary">
            {Object.entries(suggestion.content.tabs ?? {})
              .map(([name, tab]) => `${name}\n${tab.markdown}`)
              .join("\n\n") || suggestion.content.markdown}
          </p>
          <Button
            size="sm"
            color="secondary"
            isDisabled={busy || applied || props.disabled}
            isLoading={busy}
            onPress={() => void insertDraft()}
          >
            {m.records_assistant_confirm_write()}
          </Button>
          {error ? <p className="text-sm text-error-primary">{error}</p> : null}
        </>
      )}
      <Link
        to="/w/$workspaceSlug/records/$recordId"
        params={{ workspaceSlug, recordId: suggestion.reportId }}
        search={{ tab: "weekly" }}
        className="text-sm text-brand-secondary"
      >
        {m.records_title()}
      </Link>
    </div>
  );
}
