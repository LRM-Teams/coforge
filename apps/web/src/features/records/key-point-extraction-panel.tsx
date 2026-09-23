import { RefreshCcw01 as Refresh } from "@untitledui/icons";
import { Link } from "@tanstack/react-router";

import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { formatAgentProfileParam } from "#src/features/agents/profile-panel/profile-panel-search";
import type { KeyPointExtractionMeta } from "./records-content";
import { ReportSectionEditor } from "./report-editor/report-section-editor";
import { RecordsReadingColumn } from "./records-reading-column";

export const KEY_POINT_EXTRACTION_TAB = "✨ 要点提炼";

/** Leader-only personal / team key-point extraction result panel. */
export function KeyPointExtractionPanel({
  extraction,
  assistantAgentId,
  restartBusy,
  onRestart,
  waitingLabel,
  /** Settings deep-link for the prompt editor (personal or team slot). */
  editPrompt,
  className,
  /** When false, skip the centered reading column (already nested in one). */
  framed = true,
}: {
  extraction: KeyPointExtractionMeta | undefined;
  assistantAgentId?: string | null;
  restartBusy?: boolean;
  onRestart?: () => void;
  waitingLabel?: string;
  editPrompt?: {
    slot: "personal" | "team";
    returnTo: string;
  };
  className?: string;
  framed?: boolean;
}) {
  const status = extraction?.status;
  const canRestart =
    Boolean(onRestart) &&
    status !== undefined &&
    status !== "generating" &&
    (status === "ready" ||
      status === "failed" ||
      status === "pending_setup" ||
      status === "awaiting_confirm");
  const showActions = Boolean(editPrompt) || canRestart;

  const body = (
    <>
      {showActions ? (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {editPrompt ? (
            <Link
              to="/records/settings"
              search={{
                tab: "weekly",
                section: "key_points",
                slot: editPrompt.slot,
                returnTo: editPrompt.returnTo,
              }}
              className="text-sm font-medium text-brand-secondary hover:underline"
            >
              {m.records_key_points_edit_prompt()}
            </Link>
          ) : null}
          {canRestart ? (
            <Button
              type="button"
              size="sm"
              color="secondary"
              iconLeading={Refresh}
              isDisabled={restartBusy}
              onPress={() => onRestart?.()}
            >
              {m.records_key_points_restart()}
            </Button>
          ) : null}
        </div>
      ) : null}

      {status === "generating" ? (
        <p className="text-sm text-tertiary">{m.records_key_points_generating()}</p>
      ) : null}
      {status === "awaiting_confirm" ? (
        <p className="text-sm text-tertiary">{m.records_key_points_awaiting_confirm()}</p>
      ) : null}
      {status === "pending_setup" ? (
        <div className="space-y-2 rounded-xl border border-secondary bg-warning-primary p-3">
          <p className="text-sm text-secondary">{m.records_key_points_pending_setup()}</p>
          {assistantAgentId ? (
            <Link
              to="/agents"
              search={{
                profile: formatAgentProfileParam(assistantAgentId),
                agentTab: "profile",
              }}
              className="text-sm font-semibold text-brand-secondary"
            >
              {m.records_weekly_ai_setup_action()}
            </Link>
          ) : null}
        </div>
      ) : null}
      {status === "failed" && extraction?.error === "no_submitted_member_reports" ? (
        <p className="text-sm text-tertiary">
          {waitingLabel ?? m.records_key_points_waiting_submit()}
        </p>
      ) : null}
      {status === "failed" && extraction?.error !== "no_submitted_member_reports" ? (
        <p className="text-sm text-error-primary">
          {extraction?.error?.trim() || m.records_key_points_failed()}
        </p>
      ) : null}
      {(status === "ready" || status === "generating" || status === "awaiting_confirm") &&
      extraction?.markdown ? (
        <ReportSectionEditor
          key={`${status}:${extraction.markdown.length}:${extraction.markdown.slice(0, 32)}`}
          defaultValue={extraction.markdown}
          editable={false}
          placeholder=""
          onUpdate={() => {}}
        />
      ) : null}
      {status === "ready" && !extraction?.markdown ? (
        <p className="text-sm text-tertiary">{m.records_key_points_empty_result()}</p>
      ) : null}
      {!status ? (
        <p className="text-sm text-tertiary">
          {waitingLabel ?? m.records_key_points_waiting_submit()}
        </p>
      ) : null}
    </>
  );

  if (!framed) {
    return <div className={cn("space-y-4", className)}>{body}</div>;
  }

  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto", className)}>
      <RecordsReadingColumn className="space-y-4">{body}</RecordsReadingColumn>
    </div>
  );
}
